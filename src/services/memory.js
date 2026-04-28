import fs from 'fs/promises';
import path from 'path';

/**
 * 记忆系统管理
 * 负责读取和写入 memory/ 目录下的文件
 */
class MemoryService {
  constructor(config = {}) {
    this.directory = config.directory || './memory';
    this.userProfileFile = config.userProfile || 'USER_PROFILE.md';
    this.habitsFile = config.habits || 'HABITS.md';
    this.factsFile = config.facts || 'FACTS.md';
    this.environmentFile = config.environment || 'ENVIRONMENT.md';
  }

  /**
   * 初始化记忆目录
   */
  async init() {
    try {
      await fs.mkdir(this.directory, { recursive: true });
      
      // 确保文件存在
      const files = [this.userProfileFile, this.habitsFile, this.factsFile, this.environmentFile];
      for (const file of files) {
        const filePath = path.join(this.directory, file);
        try {
          await fs.access(filePath);
        } catch {
          if (file === this.environmentFile) {
            await fs.writeFile(filePath, `# 环境状态 (最近更新: ${new Date().toLocaleString()})\n\n## 传感器上报\n- 暂无数据\n\n## 户外天气\n- 暂无数据\n\n## 未来七天预报\n- 暂无数据\n`);
          } else {
            await fs.writeFile(filePath, `# ${file.replace('.md', '')}\n\n`);
          }
        }
      }
      
      console.log('[Memory] Initialized');
    } catch (error) {
      console.error('[Memory] Init error:', error.message);
      throw error;
    }
  }

  /**
   * 读取用户偏好
   * @returns {string} 用户偏好内容
   */
  async loadUserProfile() {
    return this.readFile(this.userProfileFile);
  }

  /**
   * 读取习惯记录
   * @returns {string} 习惯记录内容
   */
  async loadHabits() {
    return this.readFile(this.habitsFile);
  }

  /**
   * 读取家居信息
   * @returns {string} 家居信息内容
   */
  async loadFacts() {
    return this.readFile(this.factsFile);
  }

  /**
   * 更新用户偏好
   * @param {string} content - 新内容
   */
  async updateUserProfile(content) {
    return this.writeFile(this.userProfileFile, content);
  }

  /**
   * 更新习惯记录
   * @param {string} content - 新内容
   */
  async updateHabits(content) {
    return this.writeFile(this.habitsFile, content);
  }

  /**
   * 更新家居信息
   * @param {string} content - 新内容
   */
  async updateFacts(content) {
    return this.writeFile(this.factsFile, content);
  }

  /**
   * 读取环境信息
   */
  async loadEnvironment() {
    return this.readFile(this.environmentFile);
  }

  /**
   * 更新环境信息
   */
  async updateEnvironment(content) {
    return this.writeFile(this.environmentFile, content);
  }

  /**
   * 读取文件
   * @param {string} filename - 文件名
   * @returns {string} 文件内容
   */
  async readFile(filename) {
    try {
      const filePath = path.join(this.directory, filename);
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  /**
   * 写入文件
   * @param {string} filename - 文件名
   * @param {string} content - 内容
   */
  async writeFile(filename, content) {
    try {
      const filePath = path.join(this.directory, filename);
      await fs.writeFile(filePath, content, 'utf-8');
      console.log(`[Memory] Updated: ${filename}`);
      return true;
    } catch (error) {
      console.error(`[Memory] Write error (${filename}):`, error.message);
      throw error;
    }
  }

  /**
   * 获取所有记忆内容 (用于构建 AI 上下文)
   * @returns {object} 所有记忆
   */
  async getAll() {
    return {
      userProfile: await this.loadUserProfile(),
      habits: await this.loadHabits(),
      facts: await this.loadFacts(),
      environment: await this.loadEnvironment(),
    };
  }
}

export default MemoryService;
