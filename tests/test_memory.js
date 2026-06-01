import MemoryService from '../src/services/memory.js';
import fs from 'fs/promises';
import path from 'path';

async function testMemory() {
  const testDir = './memory_test';
  
  try {
    // 1. 初始化 MemoryService，指向测试目录
    const memory = new MemoryService({
      directory: testDir,
      user_profile: 'USER_PROFILE.md',
      knowledge: 'KNOWLEDGE.md',
      facts: 'FACTS.md',
      context: 'CONTEXT.md'
    });

    console.log('Initializing test memory directory...');
    await memory.init();

    // 2. 测试写入初始内容
    console.log('Testing updateUserProfile with initial text...');
    await memory.updateUserProfile('Initial User Profile text');

    // 3. 测试追加内容
    console.log('Testing updateUserProfile append...');
    await memory.updateUserProfile('Appended User Profile text');

    // 4. 读取并验证是否已经追加
    const profile = await memory.loadUserProfile();
    console.log('Current User Profile:\n', profile);

    if (profile.includes('Initial User Profile text') && profile.includes('Appended User Profile text')) {
      console.log('✅ Success: Appended correctly!');
    } else {
      console.error('❌ Fail: Did not append correctly.');
    }

    // 5. 测试重复追加防重逻辑
    console.log('Testing deduplication logic (adding same text again)...');
    await memory.updateUserProfile('Appended User Profile text');
    const profileAfterDup = await memory.loadUserProfile();
    
    // 计算 occurrences
    const occurrences = (profileAfterDup.match(/Appended User Profile text/g) || []).length;
    if (occurrences === 1) {
      console.log('✅ Success: Deduplication works perfectly!');
    } else {
      console.error(`❌ Fail: Content duplicated. Occurrences: ${occurrences}`);
    }

    // 6. 测试边界条件防误判逻辑 (如果追加的文本仅仅是已有文本的一个子串，但不是整行/整段，不应该被去重拦截)
    console.log('Testing boundary check (substring should not be incorrectly deduplicated)...');
    await memory.updateUserProfile('Profile');
    const profileAfterSubstring = await memory.loadUserProfile();
    if (profileAfterSubstring.includes('Profile') && profileAfterSubstring.split('\n').map(s => s.trim()).includes('Profile')) {
      console.log('✅ Success: Substring boundary check works perfectly!');
    } else {
      console.error('❌ Fail: Substring incorrectly deduplicated.');
    }

    // 7. 测试 overwrite 选项
    console.log('Testing overwrite options...');
    await memory.updateUserProfile('Overwritten User Profile', { overwrite: true });
    const profileOverwritten = await memory.loadUserProfile();
    console.log('Overwritten profile:', profileOverwritten);
    if (profileOverwritten.trim() === 'Overwritten User Profile') {
      console.log('✅ Success: Overwrite option works perfectly!');
    } else {
      console.error('❌ Fail: Overwrite option failed.');
    }

  } catch (error) {
    console.error('Error during testing:', error);
  } finally {
    // 清理测试目录
    try {
      console.log('Cleaning up test directory...');
      await fs.rm(testDir, { recursive: true, force: true });
      console.log('Cleanup done.');
    } catch (e) {
      console.error('Cleanup error:', e);
    }
  }
}

testMemory();
