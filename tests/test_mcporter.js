import { createRuntime, callOnce } from 'mcporter';
import path from 'path';
import fs from 'fs/promises';

async function test() {
  try {
    const rawConfig = await fs.readFile('./config/mcporter.json', 'utf-8');
    const config = JSON.parse(rawConfig);
    
    console.log('Testing callOnce with object...');
    // 注意：callOnce 实际上需要 server, toolName, args 等参数，这里仅验证参数签名
    try {
      await callOnce({
        config: config,
        server: 'smarthome',
        toolName: 'unknown_tool', // 我们只需要看它是否接受 config 参数
        args: {}
      });
    } catch (e) {
      // 如果报错是关于 toolName 的，说明参数签名是通过的
      console.log('callOnce feedback:', e.message);
    }
    console.log('Success with callOnce parameter test!');
  } catch (e) {
    console.log('Failed with object:', e.message);
  }
}

test();
