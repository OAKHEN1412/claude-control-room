// English counterpart of the clip brief in clipPrompt.ts. Used only when settings.lang === 'en'; the Thai brief is unchanged.
// Same structure, facts, rules and section order as the Thai brief. Thai text that remains on purpose, because the
// web UI (clipProgress.ts) and the server match it literally: the step marker `ขั้น N/5`, the stop phrase `พร้อม render`,
// and the go-ahead message `render ได้` that the server sends. Cast names and style data are user/Thai constants.
import type { ClipSettings } from '../../shared/protocol';
import { CLIP_VOICE_MODEL } from '../../shared/protocol';
import type { BuildPromptInput } from './clipPrompt';

export const NO_RENDER_RULE_EN =
  'Golden rule: do NOT render (do not run `hyperframes render` at any quality) until the user orders it. When the composition has passed the checks and is ready, stop and print "พร้อม render" and wait. The user will send the message "render ได้" when you may render.';

const LENGTH_TEXT_EN: Record<ClipSettings['length'], string> = { '30s': '30 seconds', '60s': '60 seconds', '90s': '90 seconds', '3min': '3 minutes' };
const RATIO_TEXT_EN: Record<ClipSettings['ratio'], string> = { '16:9': '16:9 (1920x1080)', '9:16': '9:16 vertical (1080x1920)', '1:1': '1:1 (1080x1080)' };

/** English version of settingsLine() in clipPrompt.ts. */
export function settingsLineEn(s: ClipSettings): string {
  const cast = s.cast.length > 0 ? s.cast.join(', ') : 'none';
  const outroOn = s.outro && s.outro.on && s.outro.text.trim() !== '';
  return [
    `length ${LENGTH_TEXT_EN[s.length]}`,
    `ratio ${RATIO_TEXT_EN[s.ratio]}`,
    `language ${s.lang === 'th' ? 'Thai' : 'English'}`,
    s.voice ? 'voice-over on' : 'voice-over off',
    s.music ? 'music on' : 'music off',
    `cast ${cast}`,
    ...(outroOn ? ['ending scene on'] : []),
  ].join(' · ');
}

/** English brief for a clip request whose settings.lang is 'en'. Same input and purity as buildClipPrompt. */
export function buildClipPromptEn({ req, style, cwd }: BuildPromptInput): string {
  const { settings } = req;
  const points = req.points
    .split(/[,\n،]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const noSubagent = style.kind === 'ours' && style.style.noSubagents === true;
  const outroText = settings.outro && settings.outro.on ? settings.outro.text.trim() : '';
  const outro = outroText === '' ? null : outroText;
  const L: string[] = [];

  L.push('You are making a video clip with HyperFrames (HTML rendered to video), following our existing clip workflow. Work in this folder:');
  L.push(cwd);
  L.push('');
  L.push(`Topic: ${req.topic.trim()}`);
  L.push(points.length > 0 ? `Points that must be included: ${points.join(' / ')}` : 'Points that must be included: none specified (choose them yourself so they cover the meaning and give examples)');
  L.push(`Settings: ${settingsLineEn(settings)}`);
  L.push('');

  L.push('## Style');
  if (style.kind === 'ours') {
    const s = style.style;
    L.push(`Our style: ${s.name} (${s.note}).`);
    L.push(`Source project: ${s.sourceDir}`);
    L.push(`Read and copy the workflow / style files from the source into the work folder (do not edit the original): ${s.workflowFiles.join(', ')}`);
    L.push('Start by reading AGENTS.md / CLAUDE.md of the source project and follow the rules there. Use the same characters and assets as the source project.');
    for (const r of s.extraRules) L.push(`- ${r}`);
  } else {
    const s = style.style;
    L.push(`Lemo-Opuscar style: ${s.name}${s.nameZh ? ` (${s.nameZh})` : ''} · category ${s.category} · style id: ${s.id}`);
    L.push('Use the lemo-opuscar skill with this style id (call the lemo-opuscar skill and choose the style by its id).');
    if (s.stylePath) L.push(`Style folder: ${s.stylePath} (read DIRECTOR.md and the style files in it before building)`);
    L.push('This style is designed for Claude to build.');
  }
  L.push('');

  L.push('## Voice / music');
  if (settings.voice && req.voiceId) {
    L.push(`Voice-over: ElevenLabs model ${CLIP_VOICE_MODEL}, voice ID ${req.voiceId}${settings.lang === 'th' ? ', language_code th' : ', language_code en'}.`);
    L.push('- Write the narration so it flows as one continuous take; cut the scenes at the word timestamps (endpoint /v1/text-to-speech/<voice>/with-timestamps).');
    L.push('- API key: it is available in the environment variable `ELEVENLABS_API_KEY`; pass it into the script environment. Do not read the key from a .env file, and do not print or write the key to any file.');
    L.push('- Send the JSON as UTF-8 through a file (Python with ensure_ascii=False), not with curl -d. Call the API one request at a time (parallel calls get 429).');
  } else {
    L.push('No voice-over: use on-screen text, music and sound effects instead (do not call ElevenLabs).');
  }
  L.push(settings.music ? '- Music: free music only (media-use / HeyGen catalog), and lower the music under the voice-over.' : '- No music. Light sound effects on the beat are fine.');
  L.push('');

  if (outro) {
    L.push('## Ending (outro)');
    L.push(`The final scene of the clip (about 3-5 seconds, counted within the chosen length, not added on top) must show this ending text on screen clearly, easy to read at ${RATIO_TEXT_EN[settings.ratio]}. Fit the lettering and colours to the chosen style. Use the text exactly, character for character; do not edit or cut any words:`);
    for (const line of outro.split('\n')) L.push(`> ${line}`);
    L.push(settings.voice && req.voiceId ? `The narrator also reads this ending text (${settings.lang === 'th' ? 'Thai' : 'English'}) in the final scene.` : 'No voice-over: show it as on-screen text only.');
    L.push('Put this ending scene in the storyboard clearly as the final scene.');
    L.push('');
  }

  L.push('## Who does which step');
  if (noSubagent) {
    L.push('This style must not use subagents: write the script, the storyboard and build all the scenes yourself in this session.');
  } else if (req.scriptModel === req.builderModel) {
    L.push(`Write the script and the storyboard yourself (model ${req.builderModel}), then build the scenes.`);
  } else {
    L.push(`Script and storyboard: send them to a subagent running model ${req.scriptModel} to write (Agent tool, model: "${req.scriptModel}"), then read its result and fix it before using it.`);
    L.push(`Build the scenes (write the composition code): you do it yourself (model ${req.builderModel}).`);
  }
  L.push('');

  L.push('## Steps and reporting');
  L.push('Do the steps in order: 1 script → 2 storyboard → 3 build scenes → 4 preview + check (hyperframes check/lint, snapshots to see the real frames) → 5 ready to render.');
  L.push('When you start each step, print one line in this form (the web UI reads it to show progress; keep the marker `ขั้น N/5` exactly as written, do not translate it): `ขั้น N/5 <step name>`, for example `ขั้น 2/5 storyboard`.');
  L.push('');
  L.push(NO_RENDER_RULE_EN);
  L.push('Step 5/5: print the line `ขั้น 5/5 พร้อม render` (the phrase "พร้อม render" is read by the web UI) with a short summary of what the clip contains, then stop immediately.');
  return L.join('\n');
}
