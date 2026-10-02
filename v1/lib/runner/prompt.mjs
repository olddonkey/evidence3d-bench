// The harness prompt: the only message a contestant receives. It is identical
// for every system apart from the paragraph that names that system's tools, so
// a score difference between systems is not a difference in instructions. The
// task itself (what to build, frame, evidence list, scoring notes) is in
// input/task.json, which the contestant is told to read.
export const PROMPT_VERSION = 'e3d-runner-prompt-v1';

export const TOOL_DESCRIPTIONS = {
  codex: 'Your tools: a shell whose commands run in this directory (Node.js is on PATH), a patch tool for creating and editing files, ' +
    'and view_image, which shows you a PNG or JPEG file. Use view_image to look at the evidence and at your own previews.',
  'claude-code': 'Your tools: Bash, whose commands run in this directory (Node.js is on PATH); Read, which also shows you PNG and JPEG files; ' +
    'Glob; Grep; Edit; Write. Use Read to look at the evidence and at your own previews.',
};

function duration(seconds) {
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  if (!minutes) return seconds + ' seconds';
  return minutes + ' minute' + (minutes === 1 ? '' : 's') + (rest ? ' ' + rest + ' seconds' : '') + ' (' + seconds + ' seconds)';
}

export function buildPrompt({ system, task, threeVersion = '0.180.0' }) {
  const tools = TOOL_DESCRIPTIONS[system];
  if (!tools) throw new Error('No tool description for system ' + system);
  const seconds = task.budget.wall_seconds;
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error('Task budget has no wall_seconds');
  return `You are taking part in a 3D reconstruction benchmark. Work on your own until you are done; nobody will answer questions.

Your working directory contains everything you get:
  input/task.json      the task: what to build, the coordinate frame and units, the evidence list, the output rules and the budget
  input/inputs/        the evidence files listed in task.json (photographs, drawings, notes)
  tools/               a preview tool for your model; tools/README.md explains it
  node_modules/three   three.js ${threeVersion}, importable from Node as 'three'
  output/              your deliverables
  tmp/                 scratch space

What to do:
1. Read input/task.json first. Then look at every evidence file it lists.
2. Use only the supplied evidence. Where it leaves something open, make a reasonable assumption and write it down.
3. Follow the frame and units stated in task.json exactly: metres, +Y up, ground at y = 0, the stated origin and front direction.
4. Write output/model.glb: a binary glTF 2.0 file with one scene of static triangle meshes, solid-colour materials
   (baseColorFactor; no textures), no animation, cameras or lights, and nothing that is not part of the object
   (no ground plane, no scenery). Stay within the triangle and byte budget in task.json.
5. Write output/notes.md: what you observed, what you inferred, and what you could not resolve.
6. Look at your own result before you finish: run
     node tools/preview.mjs output/model.glb --out output/preview
   then look at the images it writes, compare them with the evidence, fix what is wrong and look again.

Conditions:
- There is no network access, and nothing outside this directory is available to you. Blender is not installed.
- You get no feedback: nothing is scored or checked until you have finished.
- There is a hard time limit of ${duration(seconds)} of wall-clock time, including your own thinking. When it runs
  out the session is stopped, and whatever output/model.glb exists at that moment is what gets scored.
- You may write scripts and scratch files anywhere in this directory.

${tools}

When you are done, reply with a short summary of what you built.
`;
}
