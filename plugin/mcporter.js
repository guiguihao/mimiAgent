import { createRuntime, createServerProxy, callOnce } from 'mcporter';
import path from 'path';

/**
 * MCPorter 插件 — MCP Server 客户端
 * 通过 mcporter 连接外部 MCP Server，动态发现工具并注入 CoreAgent
 *
 * 工具名格式：mcp_{serverName}_{toolName}
 * 路由规则：CoreAgent._handleToolCall 按 mcp_ 前缀分发到本服务
 */
class MCPorterService {
  constructor(config, agent) {
    this.agent = agent;
    this.enabled = config.enabled !== false;

    // configPath: mcporter JSON 配置文件路径（相对于项目根目录）
    const relPath = config.config_path || './config/mcporter.json';
    this.configPath = path.resolve(process.cwd(), relPath);
    this.rootDir = config.root_dir || process.cwd();
    this.timeout = config.timeout || 30000;

    this.runtime = null;
    this.serverProxies = {};  // serverName → ServerProxy
    this.mcpTools = [];       // OpenAI function-calling 格式的工具列表
    this.toolMap = {};        // toolPrefix → { server, toolName }
  }

  /**
   * 启动 MCP 服务 — 连接所有配置中的 MCP Server 并发现工具
   */
  async start() {
    if (!this.enabled) {
      console.log('[MCPorter] Disabled, skipping...');
      return;
    }

    console.log('[MCPorter] Starting...');
    console.log(`[MCPorter] Config path: ${this.configPath}`);

    try {
      // 1. 读取并解析配置文件，支持 ${VAR} 环境变量替换
      const { promises: fs } = await import('fs');
      let rawConfig = await fs.readFile(this.configPath, 'utf8');
      
      // 匹配 ${VAR_NAME} 格式并替换
      rawConfig = rawConfig.replace(/\${(\w+)}/g, (match, key) => {
        return process.env[key] || match;
      });

      this.config = JSON.parse(rawConfig);

      // 2. 创建 runtime — 传入处理后的 config 对象
      this.runtime = await createRuntime({
        config: this.config,
        rootDir: this.rootDir,
      });

      // 2. 获取所有已注册的 server 名称
      const servers = this.runtime.listServers();
      console.log(`[MCPorter] Discovered ${servers.length} server(s): ${servers.join(', ')}`);

      if (servers.length === 0) {
        console.warn('[MCPorter] No MCP servers found in config. Check mcporter.json.');
        return;
      }

      // 3. 逐个 server 连接并发现工具
      for (const serverName of servers) {
        try {
          // 增加：检查该 Server 是否被禁用
          const serverConfig = this.config.mcpServers?.[serverName];
          if (serverConfig && serverConfig.enabled === false) {
            console.log(`[MCPorter] ${serverName}: Disabled in config, skipping...`);
            continue;
          }

          const tools = await this.runtime.listTools(serverName);
          console.log(`[MCPorter] ${serverName}: ${tools.length} tool(s) discovered`);

          // 创建 server proxy（提供 camelCase 属性名调用方式）
          this.serverProxies[serverName] = createServerProxy(this.runtime, serverName);

          // 4. 将每个工具转换为 OpenAI function-calling 格式
          for (const tool of tools) {
            const toolPrefix = `mcp_${serverName}_${tool.name}`;
            this.mcpTools.push(this._convertToOpenAITool(toolPrefix, tool));
            this.toolMap[toolPrefix] = {
              server: serverName,
              toolName: tool.name,
            };
            console.log(`[MCPorter]   → ${toolPrefix}: ${tool.description || 'no description'}`);
          }
        } catch (error) {
          console.warn(`[MCPorter] Failed to connect/discover ${serverName}: ${error.message}`);
        }
      }

      // 5. 注入工具到 CoreAgent
      if (this.agent && this.mcpTools.length > 0) {
        this.agent.setMCPTools(this.mcpTools, this.toolMap, this);
        console.log(`[MCPorter] ✅ Injected ${this.mcpTools.length} MCP tool(s) into CoreAgent`);
      } else if (this.mcpTools.length === 0) {
        console.warn('[MCPorter] No MCP tools discovered. Agent will have no MCP capabilities.');
      }

      console.log('[MCPorter] ✅ Started successfully');
    } catch (error) {
      console.error(`[MCPorter] Failed to start: ${error.message}`);
      // 不抛出异常，让 Agent 主流程继续运行
    }
  }

  /**
   * 停止 MCP 服务
   */
  async stop() {
    console.log('[MCPorter] Stopping...');
    if (this.runtime) {
      try {
        await this.runtime.close();
      } catch (e) {
        console.warn(`[MCPorter] Runtime close error: ${e.message}`);
      }
      this.runtime = null;
    }
    console.log('[MCPorter] Stopped');
  }

  /**
   * 执行 MCP 工具调用
   * @param {string} toolPrefix - 如 "mcp_smarthome_get_device_status"
   * @param {object} args - 工具参数
   * @returns {string} 工具结果
   */
  async callTool(toolPrefix, args = {}) {
    const mapping = this.toolMap[toolPrefix];
    if (!mapping) {
      return `未知 MCP 工具: ${toolPrefix}`;
    }

    const { server, toolName } = mapping;

    try {
      // 方式1: 通过 runtime.callTool（标准 API）
      const result = await this.runtime.callTool(server, toolName, { args });

      // CallResult 对象有 .text() 方法；原始结果直接返回
      if (result && typeof result.text === 'function') {
        return result.text();
      }

      // 字符串直接返回
      if (typeof result === 'string') {
        return result;
      }

      // 其他类型序列化
      return JSON.stringify(result, null, 2);
    } catch (error) {
      console.error(`[MCPorter] Call ${toolPrefix} error: ${error.message}`);

      // 方式2: fallback 到 callOnce（独立连接，不依赖 runtime）
      try {
        const fallbackResult = await callOnce({
          server,
          toolName,
          args,
          config: this.config,
        });

        if (fallbackResult && typeof fallbackResult.text === 'function') {
          return fallbackResult.text();
        }
        if (typeof fallbackResult === 'string') {
          return fallbackResult;
        }
        return JSON.stringify(fallbackResult, null, 2);
      } catch (fallbackError) {
        return `MCP 工具调用失败: ${error.message}`;
      }
    }
  }

  /**
   * 将 MCP 工具 schema 转换为 OpenAI function-calling 格式
   */
  _convertToOpenAITool(toolPrefix, tool) {
    const parameters = tool.inputSchema || { type: 'object', properties: {}, required: [] };

    return {
      type: 'function',
      function: {
        name: toolPrefix,
        description: `[MCP:${tool.name}] ${tool.description || '无描述'}`,
        parameters: parameters,
      },
    };
  }

  getInjectedTools() {
    return this.mcpTools;
  }

  getToolMap() {
    return this.toolMap;
  }
}

export default MCPorterService;