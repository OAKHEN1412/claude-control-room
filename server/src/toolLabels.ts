// Plain Thai labels for tool calls, shared by the timeline and the "thought" line.
// Pure and never throws. Output is "<label>" or "<label>: <detail>" (not clipped here).

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const firstLine = (s: string): string => oneLine(s.split(/\r?\n/).find((l) => l.trim()) ?? '');

/** Last two path segments ("src/App.tsx"); a URL or non-path text is returned unchanged. */
export function shortPath(p: string): string {
  const t = p.trim();
  if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  const parts = t.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? parts.join('/') || t : parts.slice(-2).join('/');
}

/** File name only. */
export function baseName(p: string): string {
  const parts = p.trim().split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p.trim();
}

const CHROME: Record<string, string> = {
  navigate: 'เปิดหน้า',
  computer: 'ควบคุมหน้าเว็บ',
  javascript_tool: 'รันสคริปต์ในหน้า',
  get_page_text: 'อ่านข้อความหน้าเว็บ',
  read_page: 'อ่านโครงหน้าเว็บ',
  find: 'หาองค์ประกอบ',
  form_input: 'กรอกฟอร์ม',
  tabs_context_mcp: 'ดูแท็บ',
  tabs_create_mcp: 'เปิดแท็บใหม่',
  tabs_close_mcp: 'ปิดแท็บ',
  resize_window: 'ปรับขนาดหน้าต่าง',
  read_console_messages: 'อ่าน console',
  read_network_requests: 'ดูคำขอเครือข่าย',
  file_upload: 'อัปโหลดไฟล์',
  upload_image: 'อัปโหลดรูป',
  browser_batch: 'ชุดคำสั่งเบราว์เซอร์',
  gif_creator: 'ทำ GIF',
  list_connected_browsers: 'ดูเบราว์เซอร์',
  select_browser: 'เลือกเบราว์เซอร์',
  switch_browser: 'สลับเบราว์เซอร์',
};

const CHROME_ACTION: Record<string, string> = {
  screenshot: 'ถ่ายภาพหน้าจอ',
  zoom: 'ซูมดูภาพ',
  left_click: 'คลิก',
  right_click: 'คลิกขวา',
  double_click: 'ดับเบิลคลิก',
  triple_click: 'คลิกสามครั้ง',
  type: 'พิมพ์',
  key: 'กดปุ่ม',
  scroll: 'เลื่อนหน้า',
  scroll_to: 'เลื่อนไปที่',
  wait: 'รอ',
  hover: 'ชี้เมาส์',
  left_click_drag: 'ลากเมาส์',
};

const NOTION: Record<string, string> = {
  search: 'ค้นหา',
  fetch: 'เปิดหน้า',
  'create-pages': 'สร้างหน้า',
  'update-page': 'แก้หน้า',
  'query-data-sources': 'ค้นฐานข้อมูล',
  'query-multiple-data-sources': 'ค้นฐานข้อมูล',
  'create-comment': 'คอมเมนต์',
  'get-comments': 'อ่านคอมเมนต์',
  'move-pages': 'ย้ายหน้า',
  'delete-pages': 'ลบหน้า',
  'duplicate-page': 'คัดลอกหน้า',
  'create-database': 'สร้างฐานข้อมูล',
  'update-data-source': 'แก้ฐานข้อมูล',
  'get-users': 'ดูผู้ใช้',
  'get-self': 'ดูบัญชี',
  'memory-search': 'ค้นความจำ',
};

const PC_HANDS: Record<string, string> = {
  screenshot: 'ถ่ายภาพจอ',
  click: 'คลิก',
  type_text: 'พิมพ์',
  press_keys: 'กดปุ่ม',
  scroll: 'เลื่อน',
  find_elements: 'หาปุ่ม/ช่อง',
  focus_window: 'โฟกัสหน้าต่าง',
  list_windows: 'ดูหน้าต่าง',
  ocr: 'อ่านตัวอักษรบนจอ',
  read_text: 'อ่านข้อความบนจอ',
  open_app: 'เปิดแอป',
  screen_info: 'ดูข้อมูลจอ',
  line_prepare: 'LINE เตรียมส่ง',
  line_open_chat: 'LINE เปิดแชต',
  line_send: 'LINE ส่งข้อความ',
  line_cancel: 'LINE ยกเลิก',
};

const withDetail = (label: string, detail: string): string => {
  const d = oneLine(detail);
  return d ? `${label}: ${d}` : label;
};

function mcpLabel(name: string, s: Record<string, unknown>): string {
  const rest = name.slice('mcp__'.length);
  const i = rest.indexOf('__');
  const server = i >= 0 ? rest.slice(0, i) : rest;
  const tool = i >= 0 ? rest.slice(i + 2) : '';
  if (server === 'claude-in-chrome') {
    if (tool === 'computer') return `เบราว์เซอร์: ${CHROME_ACTION[str(s.action)] ?? CHROME.computer}`;
    if (tool === 'navigate') return withDetail('เบราว์เซอร์: เปิดหน้า', shortPath(str(s.url)));
    return `เบราว์เซอร์: ${CHROME[tool] ?? tool}`;
  }
  if (server === 'notion') {
    const t = tool.replace(/^notion-/, '');
    return `Notion: ${NOTION[t] ?? t}`;
  }
  if (server === 'pc-hands') return `คุมหน้าจอ: ${PC_HANDS[tool] ?? tool}`;
  const clean = server.replace(/^claude_ai_/, '').replace(/_/g, ' ');
  return tool ? `${clean}: ${tool}` : clean;
}

/** Thai label + short detail for a tool call. */
export function toolLabel(name: string, input: unknown): string {
  const n = typeof name === 'string' && name ? name : 'tool';
  const s: Record<string, unknown> = isObj(input) ? input : {};
  if (n.startsWith('mcp__')) return mcpLabel(n, s);
  switch (n) {
    case 'Bash':
      return withDetail('คำสั่ง', str(s.description).trim() || firstLine(str(s.command)));
    case 'Read':
      return withDetail('อ่านไฟล์', baseName(str(s.file_path)));
    case 'Edit':
    case 'MultiEdit':
      return withDetail('แก้ไฟล์', baseName(str(s.file_path)));
    case 'NotebookEdit':
      return withDetail('แก้ไฟล์', baseName(str(s.notebook_path) || str(s.file_path)));
    case 'Write':
      return withDetail('เขียนไฟล์', baseName(str(s.file_path)));
    case 'Grep':
    case 'Glob':
      return withDetail('ค้นไฟล์', str(s.pattern));
    case 'Agent':
    case 'Task':
      return withDetail('ส่งงานย่อย', str(s.description).trim() || firstLine(str(s.prompt)));
    case 'WebSearch':
      return withDetail('ค้นเว็บ', str(s.query));
    case 'WebFetch':
      return withDetail('เปิดเว็บ', shortPath(str(s.url)));
    case 'ToolSearch':
      return 'โหลดเครื่องมือ';
    case 'AskUserQuestion': {
      const q = Array.isArray(s.questions) && isObj(s.questions[0]) ? s.questions[0] : null;
      return withDetail('ถามคุณ', q ? str(q.question) : '');
    }
    case 'Skill':
      return withDetail('ใช้ skill', str(s.skill));
    case 'Artifact':
      return 'หน้า artifact';
    default: {
      const first = Object.values(s).find((v) => typeof v === 'string' && v.trim());
      return withDetail(n, typeof first === 'string' ? first : '');
    }
  }
}
