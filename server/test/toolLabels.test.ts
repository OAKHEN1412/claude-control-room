import { describe, it, expect } from 'vitest';
import { toolLabel, shortPath } from '../src/toolLabels';

describe('shortPath', () => {
  it('keeps the last two segments', () => {
    expect(shortPath('C:\\Users\\a\\proj\\src\\App.tsx')).toBe('src/App.tsx');
    expect(shortPath('/a/b/c.ts')).toBe('b/c.ts');
    expect(shortPath('c.ts')).toBe('c.ts');
    expect(shortPath('http://127.0.0.1:5173/x/y/z')).toBe('http://127.0.0.1:5173/x/y/z');
  });
});

describe('toolLabel', () => {
  it('built-in tools', () => {
    expect(toolLabel('Bash', { command: 'ls', description: 'List' })).toBe('คำสั่ง: List');
    expect(toolLabel('Bash', { command: 'first\nsecond' })).toBe('คำสั่ง: first');
    expect(toolLabel('Read', { file_path: 'C:\\a\\b\\c.ts' })).toBe('อ่านไฟล์: c.ts');
    expect(toolLabel('Edit', { file_path: '/a/b/c.ts' })).toBe('แก้ไฟล์: c.ts');
    expect(toolLabel('Write', { file_path: '/a/b/d.ts' })).toBe('เขียนไฟล์: d.ts');
    expect(toolLabel('Grep', { pattern: 'TODO' })).toBe('ค้นไฟล์: TODO');
    expect(toolLabel('Glob', { pattern: '**/*.ts' })).toBe('ค้นไฟล์: **/*.ts');
    expect(toolLabel('Agent', { description: 'Review', prompt: 'long' })).toBe('ส่งงานย่อย: Review');
    expect(toolLabel('WebSearch', { query: 'q' })).toBe('ค้นเว็บ: q');
    expect(toolLabel('WebFetch', { url: 'https://x.invalid/a' })).toBe('เปิดเว็บ: https://x.invalid/a');
    expect(toolLabel('ToolSearch', { query: 'select:Read' })).toBe('โหลดเครื่องมือ');
    expect(toolLabel('AskUserQuestion', { questions: [{ question: 'Which?' }] })).toBe('ถามคุณ: Which?');
    expect(toolLabel('Skill', { skill: 'handoff' })).toBe('ใช้ skill: handoff');
    expect(toolLabel('Artifact', { file_path: 'x.html' })).toBe('หน้า artifact');
  });

  it('chrome, notion, pc-hands and generic mcp tools', () => {
    expect(toolLabel('mcp__claude-in-chrome__navigate', { url: 'http://127.0.0.1:5173/' })).toBe('เบราว์เซอร์: เปิดหน้า: http://127.0.0.1:5173/');
    expect(toolLabel('mcp__claude-in-chrome__computer', { action: 'screenshot' })).toBe('เบราว์เซอร์: ถ่ายภาพหน้าจอ');
    expect(toolLabel('mcp__claude-in-chrome__computer', { action: 'zoom' })).toBe('เบราว์เซอร์: ซูมดูภาพ');
    expect(toolLabel('mcp__claude-in-chrome__computer', { action: 'left_click' })).toBe('เบราว์เซอร์: คลิก');
    expect(toolLabel('mcp__claude-in-chrome__javascript_tool', { text: 'x' })).toBe('เบราว์เซอร์: รันสคริปต์ในหน้า');
    expect(toolLabel('mcp__claude-in-chrome__get_page_text', {})).toBe('เบราว์เซอร์: อ่านข้อความหน้าเว็บ');
    expect(toolLabel('mcp__notion__notion-search', { query: 'x' })).toBe('Notion: ค้นหา');
    expect(toolLabel('mcp__notion__notion-weird-tool', {})).toBe('Notion: weird-tool');
    expect(toolLabel('mcp__pc-hands__screenshot', {})).toBe('คุมหน้าจอ: ถ่ายภาพจอ');
    expect(toolLabel('mcp__rea__open_binary', { path: 'x' })).toBe('rea: open_binary');
    expect(toolLabel('mcp__claude_ai_Gmail__search_threads', {})).toBe('Gmail: search_threads');
  });

  it('never returns a raw mcp__ name', () => {
    expect(toolLabel('mcp__x__y', null)).not.toContain('mcp__');
    expect(toolLabel('mcp__x', {})).toBe('x');
  });

  it('unknown tools fall back to name + first string', () => {
    expect(toolLabel('Thing', {})).toBe('Thing');
    expect(toolLabel('Thing', { a: 'v' })).toBe('Thing: v');
  });
});
