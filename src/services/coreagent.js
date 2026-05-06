/**
 * CoreAgent - mimi 核心 Agent 引擎
 * 基于 guiguihao/mimi/src/core/agent.py 设计
 * 支持工具调用循环、记忆管理、定时任务、心跳巡检
 */
import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant named "{name}".`;

class CoreAgent {
  constructor(modelConfig = {}) {
    this.name = modelConfig.name || 'mimi';
    this.systemPrompt = modelConfig.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.maxContextTurns = modelConfig.maxContextTurns || 20;
    this.maxToolIterations = modelConfig.maxToolIterations || 10;
    this.sessionDir = modelConfig.sessionDir || './sessions';
    console.log(`[CoreAgent] model=${modelConfig.model}, baseUrl=${modelConfig.baseUrl}`);

    this.client = new OpenAI({
      baseURL: modelConfig.baseUrl,
      apiKey: modelConfig.apiKey,
      timeout: modelConfig.timeout || 60000,
    });
    this.model = modelConfig.model;
    this.thinking = modelConfig.thinking || false;
    this.stream = modelConfig.stream || false;

    this._sessions = {};
    this._memoryService = null;
    this._skillService = null;   // 技能服务
    this._workflowService = null; // 工作流服务
    this._workspace = '';          // 工作目录
    this._scheduler = null;
    this._heartbeat = null;
    this._onCronTaskExecute = null;
    this._mcpTools = [];         // MCP 工具列表（OpenAI function-calling 格式）
    this._mcpToolMap = {};       // toolPrefix → { server, toolName, schema }
    this._mcpService = null;     // MCPorterService 实例
  }

  setSkill(skillService) {
    this._skillService = skillService;
  }

  setWorkflow(workflowService) {
    this._workflowService = workflowService;
  }

  setWorkspace(workspacePath) {
    this._workspace = workspacePath;
  }

  setMemory(memoryService) {
    this._memoryService = memoryService;
  }

  setScheduler(scheduler) {
    this._scheduler = scheduler;
  }

  setHeartbeat(heartbeat) {
    this._heartbeat = heartbeat;
  }

  /**
   * 注入 MCP 工具到 CoreAgent
   * @param {Array} mcpTools - OpenAI function-calling 格式的工具列表
   * @param {object} mcpToolMap - toolPrefix → { server, toolName, schema }
   * @param {object} mcpService - MCPorterService 实例（用于实际调用）
   */
  setMCPTools(mcpTools, mcpToolMap, mcpService) {
    this._mcpTools = mcpTools || [];
    this._mcpToolMap = mcpToolMap || {};
    this._mcpService = mcpService;
  }

  /**
   * 设置 Cron 任务触发时的执行回调
   * @param {Function} handler - 接收 (description, taskConfig) 的异步函数
   */
  setOnCronTaskExecute(handler) {
    this._onCronTaskExecute = handler;
  }

  async init() {
    await fs.mkdir(this.sessionDir, { recursive: true });
  }

  /**
   * 获取记忆上下文（异步）
   */
  async _loadMemoryContext() {
    if (!this._memoryService) return '';
    try {
      const all = await this._memoryService.getAll();
      const profile = all.userProfile || '';
      const knowledge = all.knowledge || '';
      const facts = all.facts || '';
      const context = all.context || '';
      return `用户偏好与画像：${profile || '无'}\n长期知识与经验：${knowledge || '无'}\n事实记录：${facts || '无'}\n当前对话背景与上下文：${context || '无'}`;
    } catch {
      return '';
    }
  }

  async _buildSystemPrompt() {
    let readmeContent = '';
    try {
      const readmePath = path.resolve(process.cwd(), 'README.md');
      readmeContent = await fs.readFile(readmePath, 'utf8');
    } catch (e) {
      console.warn('[CoreAgent] Failed to load README.md for system prompt');
    }

    return this.systemPrompt
      .replace('{name}', this.name)
      .replace(/{workspace}/g, this._workspace || process.cwd())
      .replace('{readme.md}', readmeContent)
      .replace('{time}', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
  }

  async _getAllTools(filter = null) {
    let tools = [];

    if (this._memoryService) {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'memory_get_user_profile',
            description: '获取用户偏好设置',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_update_user_profile',
            description: '更新用户偏好设置',
            parameters: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '新的偏好内容' },
              },
              required: ['content'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_get_knowledge',
            description: '获取长期知识库与经验记录',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_get_context',
            description: '获取当前对话背景与即时上下文信息',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_update_context',
            description: '更新当前对话背景与即时上下文信息（用于保存最新的关键背景或阶段性状态）',
            parameters: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '完整的上下文背景内容' },
              },
              required: ['content'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_update_knowledge',
            description: '更新长期知识库与经验记录（用于保存有价值的长期信息）',
            parameters: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '新的知识或经验内容' },
              },
              required: ['content'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_get_facts',
            description: '获取重要事实记录与关键数据',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'memory_update_facts',
            description: '更新重要事实记录与关键数据',
            parameters: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '新的事实或数据内容' },
              },
              required: ['content'],
            },
          },
        }
      );
    }

    if (this._scheduler) {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'mgmt_cron_list',
            description: '列出当前所有定时任务',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'mgmt_cron_add',
            description: '添加一个新的定时任务',
            parameters: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: '唯一英文 ID' },
                name: { type: 'string', description: '任务名称' },
                cron: { type: 'string', description: '5段 cron 表达式' },
                description: { type: 'string', description: '任务指令' },
              },
              required: ['task_id', 'name', 'cron', 'description'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'mgmt_cron_remove',
            description: '删除一个定时任务',
            parameters: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: '任务 ID' },
              },
              required: ['task_id'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'mgmt_cron_toggle',
            description: '启用或禁用一个定时任务',
            parameters: {
              type: 'object',
              properties: {
                task_id: { type: 'string', description: '任务 ID' },
                enabled: { type: 'boolean', description: 'true=启用，false=禁用' },
              },
              required: ['task_id', 'enabled'],
            },
          },
        }
      );
    }

    if (this._heartbeat) {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'mgmt_heartbeat_get',
            description: '读取当前心跳巡检的任务指令内容',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'mgmt_heartbeat_set',
            description: '修改心跳巡检任务的指令内容',
            parameters: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '新的心跳任务指令' },
              },
              required: ['content'],
            },
          },
        }
      );
    }

    // 技能工具
    if (this._skillService) {
      // 1. 保留基础技能管理工具
      tools.push(
        {
          type: 'function',
          function: {
            name: 'skill_list',
            description: '获取当前可用的技能列表',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'skill_run',
            description: '执行指定的技能',
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '技能名称' },
                params: { type: 'object', description: '传递给技能的参数（可选）' },
              },
              required: ['name'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'cmd_exec',
            description: '在服务器上执行终端命令（如运行 Python 脚本）',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string', description: '要执行的完整命令字符串' },
              },
              required: ['command'],
            },
          },
        }
      );

      // 2. 动态映射具体技能为顶级工具
      try {
        const skillList = await this._skillService.list();
        for (const skill of skillList) {
          // 避免与内置工具冲突
          if (['skill_list', 'skill_run', 'cmd_exec'].includes(skill.name)) continue;

          tools.push({
            type: 'function',
            function: {
              name: skill.name.replace(/-/g, '_'), // 统一使用下划线
              description: `[Skill] ${skill.description || skill.name}`,
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: '搜索或执行所需的参数' },
                },
                additionalProperties: true, // 允许传递更多参数
              },
            },
          });
        }
      } catch (e) {
        console.error(`[CoreAgent] 获取技能列表失败: ${e.message}`);
      }
    }

    // 工作流工具
    if (this._workflowService) {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'workflow_list',
            description: '获取当前可用工作流列表',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        {
          type: 'function',
          function: {
            name: 'workflow_run',
            description: '执行指定的工作流（如早晨例行任务、设备巡检等）',
            parameters: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '工作流 ID' },
                context: { type: 'object', description: '初始变量（可选）' },
              },
              required: ['id'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'workflow_get',
            description: '读取指定工作流的完整定义（用于编辑前先查看）',
            parameters: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '工作流 ID' },
              },
              required: ['id'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'workflow_save',
            description: '创建或更新工作流，持久化到 config/workflows/ 目录下的 YAML 文件。新工作流会创建同名 YAML 文件。',
            parameters: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '工作流唯一 ID（英文加下划线）' },
                name: { type: 'string', description: '工作流显示名称' },
                steps: {
                  type: 'array',
                  description: '步骤列表，每个元素包含 id/type 等字段',
                  items: { type: 'object' },
                },
              },
              required: ['id', 'steps'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'workflow_delete',
            description: '删除指定工作流，从 YAML 文件中移除对应条目',
            parameters: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '要删除的工作流 ID' },
              },
              required: ['id'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'workflow_reload',
            description: '重新从磁盘加载工作流配置（手动编辑 YAML 文件后使用）',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      );
    }

    // MCP 工具
    if (this._mcpTools.length > 0) {
      tools.push(...this._mcpTools);
    }

    // 应用过滤器
    if (typeof filter === 'function') {
      tools = tools.filter(filter);
    }

    return tools;
  }

  /**
   * 处理工具调用（异步）
   */
  async _handleToolCall(toolName, args = {}) {
    if (toolName.startsWith('memory_')) {
      return await this._handleMemoryTool(toolName, args);
    } else if (toolName.startsWith('mgmt_')) {
      return this._handleManagementTool(toolName, args);
    } else if (toolName.startsWith('mcp_')) {
      return await this._handleMCPToolCall(toolName, args);
    } else if (toolName.startsWith('workflow_')) {
      return await this._handleWorkflowTool(toolName, args);
    } else if (toolName.startsWith('file_')) {
      return await this._handleFileTool(toolName, args);
    } else if (toolName.startsWith('cmd_')) {
      return await this._handleCommandTool(toolName, args);
    } else if (toolName.startsWith('skill_')) {
      return await this._handleSkillTool(toolName, args);
    }

    // 兜底：尝试作为动态映射的技能处理
    if (this._skillService) {
      const skills = await this._skillService.list();
      const targetSkill = skills.find(s => s.name.replace(/-/g, '_') === toolName);
      if (targetSkill) {
        console.log(`[CoreAgent] 动态路由技能工具: ${toolName} -> ${targetSkill.name}`);
        const result = await this._skillService.run(targetSkill.name, args, this);

        // 自动脱壳：如果返回的是 {response: '...'} 或 {reply: '...'}，只取内容
        if (result && typeof result === 'object') {
          return result.response || result.reply || JSON.stringify(result);
        }
        return String(result);
      }
    }

    return `未知工具: ${toolName}`;
  }

  /**
   * 处理记忆工具调用（异步，通过 MemoryService 的正式方法读写）
   */
  async _handleMemoryTool(toolName, args = {}) {
    if (!this._memoryService) return '记忆服务未配置';

    try {
      switch (toolName) {
        case 'memory_get_user_profile':
          return await this._memoryService.loadUserProfile();
        case 'memory_update_user_profile':
          await this._memoryService.updateUserProfile(args.content);
          return '已更新用户偏好';
        case 'memory_get_knowledge':
          return await this._memoryService.loadKnowledge();
        case 'memory_update_knowledge':
          await this._memoryService.updateKnowledge(args.content);
          return '已更新长期知识库';
        case 'memory_get_facts':
          return await this._memoryService.loadFacts();
        case 'memory_update_facts':
          await this._memoryService.updateFacts(args.content);
          return '已更新事实记录';
        case 'memory_get_context':
          return await this._memoryService.loadContext();
        case 'memory_update_context':
          await this._memoryService.updateContext(args.content);
          return '已更新对话背景';
        default:
          return `未知记忆工具: ${toolName}`;
      }
    } catch (e) {
      return `错误: ${e.message}`;
    }
  }

  /**
   * 处理工作流工具调用
   */
  async _handleWorkflowTool(toolName, args = {}) {
    if (!this._workflowService) return '工作流服务未配置';
    try {
      switch (toolName) {
        case 'workflow_list':
          const list = this._workflowService.list();
          return JSON.stringify(list, null, 2);
        case 'workflow_run':
          const runResult = await this._workflowService.run(args.id, args.context || {});
          return runResult.success
            ? `工作流 "${args.id}" 执行完成。`
            : `工作流 "${args.id}" 执行失败：${runResult.error}`;
        case 'workflow_get':
          return JSON.stringify(this._workflowService.get(args.id), null, 2);
        case 'workflow_save':
          const saveResult = await this._workflowService.save({
            id: args.id,
            name: args.name || args.id,
            steps: args.steps || [],
          });
          return `工作流 "${args.id}" 已保存到 ${saveResult.file}。`;
        case 'workflow_delete':
          await this._workflowService.delete(args.id);
          return `工作流 "${args.id}" 已从文件中删除。`;
        case 'workflow_reload':
          const reloadResult = await this._workflowService.reload();
          return `已重新加载，共 ${reloadResult.count} 个工作流。`;
        default:
          return `未知工作流工具: ${toolName}`;
      }
    } catch (e) {
      return `工作流工具错误: ${e.message}`;
    }
  }

  /**
   * 处理技能工具调用
   */
  async _handleSkillTool(toolName, args = {}) {
    if (!this._skillService) return '技能服务未配置';

    try {
      switch (toolName) {
        case 'skill_list':
          return await this._skillService.list();
        case 'skill_run':
          const result = await this._skillService.run(args.name, args.params || {}, this);
          if (result && typeof result === 'object') {
            return result.response || result.reply || JSON.stringify(result);
          }
          return String(result);
        default:
          return `未知技能工具: ${toolName}`;
      }
    } catch (error) {
      return `执行技能工具失败: ${error.message}`;
    }
  }

  /**
   * 处理文件工具调用
   */
  async _handleFileTool(toolName, args = {}) {
    // 动态导入 fs 模块（ESM 环境）
    const { promises: fs } = await import('fs');
    const path = await import('path');

    try {
      switch (toolName) {
        case 'file_read':
          const content = await fs.readFile(args.path, 'utf8');
          return content;

        case 'file_write':
          await fs.writeFile(args.path, args.content, 'utf8');
          return `已写入文件: ${args.path}`;

        case 'file_append':
          await fs.appendFile(args.path, args.content, 'utf8');
          return `已追加到文件: ${args.path}`;

        case 'file_exists':
          try {
            await fs.access(args.path);
            return 'true';
          } catch {
            return 'false';
          }

        case 'file_delete':
          await fs.unlink(args.path);
          return `已删除文件: ${args.path}`;

        case 'file_list':
          const files = await fs.readdir(args.path || '.');
          return files.join('\n');

        case 'file_edit':
          return await this._editFile(fs, args.path, args);

        default:
          return `未知文件工具: ${toolName}`;
      }
    } catch (e) {
      return `文件操作错误: ${e.message}`;
    }
  }

  /**
   * 编辑文件 - 支持行号插入/删除/替换、正则查找替换
   * @param {object} fs - fs.promises 对象
   * @param {string} filePath - 文件路径
   * @param {object} args - 编辑参数
   * @returns {string} 操作结果
   */
  async _editFile(fs, filePath, args) {
    try {
      // 读取原文件内容
      let content = '';
      try {
        content = await fs.readFile(filePath, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e; // 文件不存在则创建空内容
      }

      const lines = content.split('\n');

      // 1. 行号操作 (insert_line/replace_line/delete_line)
      if (args.insert_line !== undefined) {
        const lineNum = parseInt(args.insert_line);
        if (lineNum < 0 || lineNum > lines.length) {
          return `❌ 行号超出范围 (0-${lines.length})`;
        }
        lines.splice(lineNum, 0, args.content || '');
      }

      if (args.replace_line !== undefined) {
        const lineNum = parseInt(args.replace_line);
        if (lineNum < 0 || lineNum >= lines.length) {
          return `❌ 行号超出范围 (0-${lines.length - 1})`;
        }
        lines[lineNum] = args.content || '';
      }

      if (args.delete_line !== undefined) {
        const lineNum = parseInt(args.delete_line);
        if (lineNum < 0 || lineNum >= lines.length) {
          return `❌ 行号超出范围 (0-${lines.length - 1})`;
        }
        lines.splice(lineNum, 1);
      }

      // 2. 查找替换操作 (find/replace/all)
      if (args.find) {
        const findStr = args.find;
        const replaceStr = args.replace || '';
        const findAll = args.all === true;

        let replaced = false;
        if (args.regex) {
          // 正则表达式查找替换
          try {
            const regex = new RegExp(findStr, 'g'); // 默认全局匹配
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                lines[i] = lines[i].replace(regex, replaceStr);
                replaced = true;
                if (!findAll) break;
              }
            }
          } catch (e) {
            return `❌ 正则表达式错误: ${e.message}`;
          }
        } else {
          // 普通字符串查找替换
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(findStr)) {
              lines[i] = lines[i].replace(findStr, replaceStr);
              replaced = true;
              if (!findAll) break;
            }
          }
        }

        if (!replaced) {
          return `❌ 未找到匹配内容: "${findStr}"`;
        }
      }

      // 写入文件
      const newContent = lines.join('\n');
      await fs.writeFile(filePath, newContent, 'utf8');
      return `✅ 已编辑文件: ${filePath}`;

    } catch (e) {
      return `❌ 编辑文件失败: ${e.message}`;
    }
  }

  /**
   * 处理命令工具调用
   */
  async _handleCommandTool(toolName, args = {}) {
    // 动态导入 child_process 模块（ESM 环境）
    const { exec } = await import('child_process');
    const util = await import('util');
    const execAsync = util.promisify(exec);

    try {
      switch (toolName) {
        case 'cmd_exec':
          let finalCommand = args.command;

          // 只对 browser-use open 子命令注入 --headed（有头模式）
          // 其他子命令（state/eval/click/cookies 等）不注入，避免脱离已有 daemon
          if (finalCommand.startsWith('browser-use ')) {
            const isOpenCmd = /^browser-use\s+(--\S+\s+)*open(\s|$)/.test(finalCommand);
            if (isOpenCmd && !finalCommand.includes('--headed') &&
              process.env.BROWSER_USE_HEADLESS === 'false') {
              // 先关闭可能残留的 headless daemon，确保新 daemon 以 headed 模式启动
              finalCommand = `browser-use close >/dev/null 2>&1; ` +
                finalCommand.replace('browser-use ', 'browser-use --headed ');
            }
          }

          console.log(`[CoreAgent] cmd_exec 实际执行: ${finalCommand.substring(0, 120)}`);
          const { stdout, stderr } = await execAsync(finalCommand, {
            cwd: args.cwd || process.cwd(),
            env: { ...process.env, ...args.env }, // 显式透传当前环境变量
            timeout: args.timeout || 30000,
            maxBuffer: 1024 * 1024 // 1MB
          });
          return stdout || stderr || '(无输出)';

        default:
          return `未知命令工具: ${toolName}`;
      }
    } catch (e) {
      return `命令执行错误: ${e.message}`;
    }
  }
  /**
   * 处理管理工具调用
   */
  _handleManagementTool(toolName, args = {}) {
    switch (toolName) {
      case 'mgmt_cron_list':
        if (!this._scheduler) return '调度器未配置';
        const tasks = this._scheduler.listTasks() || [];
        if (!tasks.length) return '无定时任务';
        return tasks.map(t => `[${t.id}] ${t.name} (${t.cron})`).join('\n');

      case 'mgmt_cron_add':
        if (!this._scheduler) return '调度器未配置';
        const taskConfig = {
          id: args.task_id,
          name: args.name,
          cron: args.cron,
          prompt: args.description,
          enabled: true,
        };
        this._scheduler.register(args.task_id, args.cron, async () => {
          if (this._onCronTaskExecute) {
            await this._onCronTaskExecute(args.description, taskConfig);
          } else {
            console.warn(`[CoreAgent] Cron task ${args.task_id} fired but no executor set`);
          }
        }, { name: args.name });
        return `已添加定时任务: ${args.task_id}`;

      case 'mgmt_cron_remove':
        if (!this._scheduler) return '调度器未配置';
        this._scheduler.unregister(args.task_id);
        return `已删除定时任务: ${args.task_id}`;

      case 'mgmt_cron_toggle':
        if (!this._scheduler) return '调度器未配置';
        if (args.enabled) {
          const ok = this._scheduler.enable(args.task_id);
          return ok ? `已启用任务: ${args.task_id}` : `任务 ${args.task_id} 不存在，无法启用`;
        } else {
          const ok = this._scheduler.disable(args.task_id);
          return ok ? `已禁用任务: ${args.task_id}` : `任务 ${args.task_id} 不存在，无法禁用`;
        }

      case 'mgmt_heartbeat_get':
        if (!this._heartbeat) return '心跳未配置';
        return this._heartbeat.getTaskContent() || '';

      case 'mgmt_heartbeat_set':
        if (!this._heartbeat) return '心跳未配置';
        this._heartbeat.setTaskContent(args.content);
        return '已更新心跳任务';

      default:
        return `未知管理工具: ${toolName}`;
    }
  }

  /**
   * 处理 MCP 工具调用 — 通过 MCPorterService 执行
   * @param {string} toolPrefix - 如 "mcp_context7_resolve-library-id"
   * @param {object} args - 工具参数
   * @returns {string} 工具结果
   */
  async _handleMCPToolCall(toolPrefix, args = {}) {
    const mapping = this._mcpToolMap[toolPrefix];
    if (!mapping) {
      return `MCP 工具未注册: ${toolPrefix}`;
    }

    if (!this._mcpService) {
      return 'MCP 服务未配置';
    }

    try {
      const result = await this._mcpService.callTool(toolPrefix, args);
      console.log(`[CoreAgent] MCP: ${toolPrefix} → ${String(result).substring(0, 80)}`);
      return result;
    } catch (e) {
      return `MCP 工具调用失败: ${e.message}`;
    }
  }

  /**
   * 截断历史消息，保留完整的 tool_call ↔ tool_result 配对
   * @param {Array} history - 原始历史
   * @param {number} maxLen - 最大保留条数
   * @returns {Array} 截断后的历史
   */
  _trimHistory(history, maxLen) {
    if (history.length <= maxLen) return history;

    let trimmed = history.slice(history.length - maxLen);

    // ── 新增：总字符数限制，防止上下文过长 ──
    const MAX_TOTAL_CHARS = 60000;
    let currentTotal = trimmed.reduce((sum, msg) => sum + (msg.content?.length || 0), 0);

    while (currentTotal > MAX_TOTAL_CHARS && trimmed.length > 2) {
      const removed = trimmed.shift(); // 移除最旧的消息
      currentTotal -= (removed.content?.length || 0);
    }

    // 检查开头是否有孤立的 tool_result（对应的 tool_call 被截掉了）
    const orphanStart = trimmed.findIndex(
      (msg, idx) => msg.role === 'tool' && idx === 0
    );
    if (orphanStart !== -1 && orphanStart === 0) {
      // 跳过所有连续的 orphan tool_result
      let skip = 0;
      while (skip < trimmed.length && trimmed[skip].role === 'tool') {
        skip++;
      }
      trimmed = trimmed.slice(skip);
    }

    // 同样检查开头是否有 tool_calls 但缺少后续 tool_result 的 assistant 消息
    while (trimmed.length > 0) {
      const first = trimmed[0];
      if (first.role === 'assistant' && first.tool_calls && first.tool_calls.length > 0) {
        // 检查紧跟的消息是否是对应第一个 tool_call 的 tool_result
        if (trimmed.length > 1 && trimmed[1].role === 'tool') {
          break; // 配对完整，保留
        }
        // 缺少 tool_result，移除这条 assistant 消息
        trimmed = trimmed.slice(1);
      } else {
        break;
      }
    }

    return trimmed;
  }

  _normalizeMessages(history) {
    const messages = [];
    for (const msg of history) {
      if (msg.tool_calls) {
        messages.push({
          role: msg.role,
          content: msg.content || null,
          tool_calls: msg.tool_calls,
        });
      } else if (msg.tool_call_id) {
        messages.push({
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: msg.content,
        });
      } else {
        messages.push({
          role: msg.role,
          content: msg.content || '',
        });
      }
    }
    return messages;
  }

  async _saveSession(sessionId, history) {
    const sessionPath = path.join(this.sessionDir, `${sessionId}.json`);
    try {
      await fs.writeFile(sessionPath, JSON.stringify(history, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[CoreAgent] 保存会话失败: ${e.message}`);
    }
  }

  async _loadSession(sessionId) {
    const sessionPath = path.join(this.sessionDir, `${sessionId}.json`);
    try {
      const data = await fs.readFile(sessionPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  /**
   * 核心对话方法
   * @param {string} prompt - 用户消息
   * @param {object} options - 可选参数
   * @returns {object} AI 响应
   */
  async decide(prompt, options = {}) {
    const sessionId = options.sessionId || 'default';

    // ── 指令拦截 ──
    const trimmed = prompt.trim();
    if (trimmed === '/new' || trimmed === '/新会话') {
      const result = await this.newSession(sessionId);
      return { ...result, command: 'new' };
    }
    if (trimmed === '/compress' || trimmed === '/压缩') {
      const result = await this.compressSession(sessionId);
      return { ...result, command: 'compress' };
    }
    if (trimmed === '/context' || trimmed === '/上下文') {
      const result = await this.getSessionContext(sessionId, options);
      return { ...result, command: 'context' };
    }

    if (!this._sessions[sessionId]) {
      this._sessions[sessionId] = await this._loadSession(sessionId);
    }

    const history = this._sessions[sessionId];
    history.push({ role: 'user', content: prompt });

    const maxLen = this.maxContextTurns * 2;
    this._sessions[sessionId] = this._trimHistory(history, maxLen);
    const trimmedHistory = this._sessions[sessionId];

    let systemPrompt = await this._buildSystemPrompt();
    let ctx = await this._loadMemoryContext();
    if (options.appendSystemPrompt) {
      ctx = ctx ? `${ctx}\n${options.appendSystemPrompt}` : options.appendSystemPrompt;
    }
    if (ctx) {
      systemPrompt += `\n\n## 上下文\n${ctx}`;
    }

    const messages = [{ role: 'system', content: systemPrompt }];

    // 打印会话上下文日志
    console.log(`\n[CoreAgent] === Session Context [${sessionId}] ===`);
    console.log(`[CoreAgent] System Prompt: ${systemPrompt.substring(0, 200)}...`);
    console.log(`[CoreAgent] History Length: ${trimmedHistory.length} messages`);

    messages.push(...this._normalizeMessages(trimmedHistory));

    const tools = await this._getAllTools(options.toolFilter);
    let finalResponse = '';

    for (let i = 0; i < this.maxToolIterations; i++) {
      const requestOptions = {
        model: this.model,
        messages: messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: 0.7,
        max_tokens: 4096, // 显式设置最大输出，防止某些 API 在输入过长时自动计算产生负值
      };

      // 思考模式：构建 reasoning 参数
      if (this.thinking) {
        requestOptions.temperature = 1; // 思考模式要求 temperature=1
        // OpenAI extended thinking: 通过 reasoning_effort 参数
        if (options.reasoningEffort) {
          requestOptions.reasoning_effort = options.reasoningEffort;
        }
      }

      // 流式输出模式
      if (this.stream) {
        requestOptions.stream = true;
      }

      // 根据是否流式选择不同的调用方式
      const onChunk = options.onChunk || null;
      const choice = this.stream
        ? await this._handleStreamRequest(requestOptions, onChunk)
        : await this._handleNormalRequest(requestOptions);

      const msgToStore = {
        role: choice.role,
        content: choice.content,
      };

      // 思考模式：保存 reasoning_content
      if (choice.reasoning_content) {
        msgToStore.reasoning_content = choice.reasoning_content;
      }

      if (choice.tool_calls) {
        msgToStore.tool_calls = choice.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }

      trimmedHistory.push(msgToStore);
      messages.push(msgToStore);

      // 思考模式：输出 reasoning 日志
      if (choice.reasoning_content) {
        console.log(`[CoreAgent] Thinking: ${choice.reasoning_content.substring(0, 200)}...`);
      }

      if (msgToStore.tool_calls && msgToStore.tool_calls.length > 0) {
        for (const tc of msgToStore.tool_calls) {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch (e) {
            console.warn(`[CoreAgent] 工具参数解析失败: ${tc.function.name}, raw: ${tc.function.arguments}`);
          }

          const result = await this._handleToolCall(tc.function.name, args);
          let displayResult = typeof result === 'object' ? JSON.stringify(result) : String(result);

          // 限制工具输出长度，防止撑爆上下文 (约 20,000 字符)
          if (displayResult.length > 20000) {
            console.log(`[CoreAgent] 工具 ${tc.function.name} 输出过长 (${displayResult.length})，已截断`);
            displayResult = displayResult.substring(0, 20000) + "\n\n(内容过长，已截断...)";
          }

          console.log(`[CoreAgent] 工具: ${tc.function.name} → ${displayResult.substring(0, 80)}`);

          const toolResult = { role: 'tool', tool_call_id: tc.id, content: displayResult };
          trimmedHistory.push(toolResult);
          messages.push(toolResult);
        }
        continue;
      } else {
        finalResponse = msgToStore.content || '';
        break;
      }
    }

    await this._saveSession(sessionId, trimmedHistory);

    return this.parseOutput(finalResponse);
  }

  /**
   * 普通请求（非流式）
   * @param {object} requestOptions - API 请求参数
   * @returns {object} 解析后的 choice 数据 { role, content, tool_calls, reasoning_content }
   */
  async _handleNormalRequest(requestOptions) {
    const response = await this.client.chat.completions.create(requestOptions);
    const message = response.choices[0].message;
    return {
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls || null,
      reasoning_content: message.reasoning_content || null,
    };
  }

  /**
   * 流式请求 — 逐 chunk 拼接 content / tool_calls / reasoning_content
   * @param {object} requestOptions - API 请求参数
   * @param {Function} [onChunk] - 可选回调，每收到一个 content chunk 就调用 onChunk(text)
   * @returns {object} 解析后的 choice 数据 { role, content, tool_calls, reasoning_content }
   */
  async _handleStreamRequest(requestOptions, onChunk) {
    const stream = await this.client.chat.completions.create(requestOptions);

    let content = '';
    let reasoningContent = '';
    let role = 'assistant';
    const toolCallAccumulators = {}; // { index: { id, name, arguments } }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.role) role = delta.role;
      if (delta.content) content += delta.content;
      if (delta.reasoning_content) reasoningContent += delta.reasoning_content;

      // 流式 tool_calls 拼接
      if (delta.tool_calls) {
        for (const tcDelta of delta.tool_calls) {
          const idx = tcDelta.index;
          if (!toolCallAccumulators[idx]) {
            toolCallAccumulators[idx] = {
              id: tcDelta.id || '',
              type: tcDelta.type || 'function',
              function: { name: '', arguments: '' },
            };
          }
          if (tcDelta.id) toolCallAccumulators[idx].id = tcDelta.id;
          if (tcDelta.function?.name) toolCallAccumulators[idx].function.name += tcDelta.function.name;
          if (tcDelta.function?.arguments) toolCallAccumulators[idx].function.arguments += tcDelta.function.arguments;
        }
      }

      // 回调通知 + 终端输出
      if (delta.content) {
        if (onChunk) onChunk(delta.content);
        process.stdout.write(delta.content);
      }
    }

    // 流式输出完成后换行
    if (content) process.stdout.write('\n');

    const tool_calls = Object.keys(toolCallAccumulators).length > 0
      ? Object.values(toolCallAccumulators)
      : null;

    return {
      role,
      content,
      tool_calls,
      reasoning_content: reasoningContent || null,
    };
  }

  /**
   * 持续对话
   * @param {string} sessionId - 会话 ID
   * @param {string} prompt - 后续消息
   * @returns {object} AI 响应
   */
  async continue(sessionId, prompt) {
    return this.decide(prompt, { sessionId });
  }

  /**
   * 解析输出 — 能 JSON.parse 就解析，否则直接当文本返回
   * @param {string} output - 原始输出
   * @returns {object} 解析后对象
   */
  parseOutput(output) {
    if (!output) return { response: '无响应' };

    try {
      return JSON.parse(output);
    } catch {
      return { response: output };
    }
  }

  /**
   * 清除会话历史
   * @param {string} sessionId - 会话 ID
   */
  async clearHistory(sessionId = 'default') {
    if (this._sessions[sessionId]) {
      this._sessions[sessionId] = [];
    }
    const sessionPath = path.join(this.sessionDir, `${sessionId}.json`);
    await fs.unlink(sessionPath).catch(() => { });
  }

  /**
   * 开启新会话 — 备份当前会话，清空历史，保持当前 sessionId
   * @param {string} sessionId - 当前会话 ID
   * @returns {object} { sessionId, response }
   */
  async newSession(sessionId = 'default') {
    // 1. 加载并备份
    if (!this._sessions[sessionId]) {
      this._sessions[sessionId] = await this._loadSession(sessionId);
    }
    const history = this._sessions[sessionId];

    if (history && history.length > 0) {
      const timestamp = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
      }).replace(/[\/ :]/g, '-');

      const backupPath = path.join(this.sessionDir, `${sessionId}_backup_${timestamp}.json`);
      try {
        await fs.writeFile(backupPath, JSON.stringify(history, null, 2), 'utf-8');
        console.log(`[CoreAgent] Session backed up to: ${backupPath}`);
      } catch (e) {
        console.error(`[CoreAgent] 备份会话失败: ${e.message}`);
      }
    }

    // 2. 清空
    this._sessions[sessionId] = [];
    await this._saveSession(sessionId, []);

    console.log(`[CoreAgent] Session cleared: ${sessionId}`);
    return {
      sessionId: sessionId,
      response: '🆕 会话已重置，原历史已备份。',
    };
  }

  /**
   * 压缩会话 — 用 LLM 将历史对话总结为摘要，替换原历史
   * @param {string} sessionId - 会话 ID
   * @returns {object} { response }
   */
  async compressSession(sessionId = 'default') {
    if (!this._sessions[sessionId]) {
      this._sessions[sessionId] = await this._loadSession(sessionId);
    }

    const history = this._sessions[sessionId];
    if (history.length <= 2) {
      return { response: '📝 会话很短，无需压缩。' };
    }

    // 将历史消息格式化为文本供 LLM 总结
    const historyText = history
      .map(msg => {
        const roleLabel = msg.role === 'user' ? '用户' :
          msg.role === 'assistant' ? 'AI' :
            msg.role === 'tool' ? '工具结果' :
              msg.role === 'system' ? '系统' : msg.role;
        let text = `[${roleLabel}]: ${msg.content || ''}`;
        if (msg.tool_calls) {
          text += ` (调用了工具: ${msg.tool_calls.map(tc => tc.function?.name).join(', ')})`;
        }
        return text;
      })
      .join('\n');

    // 调用 LLM 生成摘要
    const compressPrompt = `请将以下对话历史压缩为一段简洁的摘要，保留关键信息、决策和结果，去除冗余细节。用中文输出，不超过200字。\n\n${historyText}`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: '你是一个对话摘要助手，擅长提炼关键信息。' },
          { role: 'user', content: compressPrompt },
        ],
        temperature: 0.3,
        max_tokens: 300,
      });

      const summary = response.choices[0].message.content || '压缩失败';

      // 用摘要替换原历史
      this._sessions[sessionId] = [
        { role: 'system', content: `以下是之前对话的摘要：\n${summary}` },
      ];
      await this._saveSession(sessionId, this._sessions[sessionId]);

      console.log(`[CoreAgent] Session compressed: ${sessionId}, ${history.length} msgs → summary`);
      return {
        response: `📝 会话已压缩：${history.length} 条消息 → 摘要\n\n${summary}`,
      };
    } catch (error) {
      console.error(`[CoreAgent] Compress failed: ${error.message}`);
      return { response: `❌ 压缩失败: ${error.message}` };
    }
  }

  /**
   * 获取会话上下文摘要
   * @param {string} sessionId - 会话 ID
   * @param {object} options - 参数
   * @returns {object} { response }
   */
  async getSessionContext(sessionId = 'default', options = {}) {
    if (!this._sessions[sessionId]) {
      this._sessions[sessionId] = await this._loadSession(sessionId);
    }
    const history = this._sessions[sessionId];

    const systemPrompt = await this._buildSystemPrompt();
    const memoryCtx = await this._loadMemoryContext();

    let fullSystem = systemPrompt;
    if (options.appendSystemPrompt) {
      fullSystem += `\n\n## 插件上下文\n${options.appendSystemPrompt}`;
    }
    if (memoryCtx) {
      fullSystem += `\n\n## 记忆上下文\n${memoryCtx}`;
    }

    const historySummary = history.length > 0
      ? history.map((msg, i) => `${i + 1}. [${msg.role}]: ${msg.content ? msg.content.substring(0, 50) + (msg.content.length > 50 ? '...' : '') : '(工具调用)'}`).join('\n')
      : '无历史记录';

    const response = `🔍 **会话上下文 [${sessionId}]**\n\n` +
      `**系统提示词摘要:**\n${systemPrompt.substring(0, 100)}...\n\n` +
      `**记忆上下文:**\n${memoryCtx || '无'}\n\n` +
      `**历史消息 (${history.length} 条):**\n${historySummary}`;

    return { response };
  }
}

export default CoreAgent;