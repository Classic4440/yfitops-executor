import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/tmp/workspaces';

// Ensure workspace root exists
await fs.mkdir(WORKSPACE_ROOT, { recursive: true });

// POST /execute – run any command in a workspace directory
app.post('/execute', async (req, res) => {
  const { workspace_id, command, cwd } = req.body;
  if (!workspace_id || !command) {
    return res.status(400).json({ error: 'workspace_id and command required' });
  }

  const workDir = cwd || path.join(WORKSPACE_ROOT, workspace_id);
  await fs.mkdir(workDir, { recursive: true });

  // Basic security: block dangerous commands (customize as needed)
  const dangerous = ['rm -rf /', 'sudo', 'chmod 777', 'mkfs', 'dd if=', ':(){ :|:& };:'];
  if (dangerous.some(d => command.includes(d))) {
    return res.status(403).json({ error: 'Command blocked for security' });
  }

  try {
    const { stdout, stderr } = await execAsync(command, { cwd: workDir, shell: true, timeout: 60000 });
    res.json({ ok: true, stdout, stderr, exitCode: 0 });
  } catch (err) {
    res.json({ ok: false, stdout: err.stdout, stderr: err.stderr, exitCode: err.code });
  }
});

// POST /git – specialized git operations (optional, but nice)
app.post('/git', async (req, res) => {
  const { workspace_id, operation, args = [], cwd, github_token } = req.body;
  const workDir = cwd || path.join(WORKSPACE_ROOT, workspace_id);
  await fs.mkdir(workDir, { recursive: true });

  let command = '';
  switch (operation) {
    case 'clone':
      const repoUrl = args[0];
      const tokenUrl = github_token ? repoUrl.replace('https://', `https://${github_token}@`) : repoUrl;
      command = `git clone ${tokenUrl} ${workDir}`;
      break;
    case 'status':
      command = 'git status';
      break;
    case 'commit':
      command = `git commit -m "${args.join(' ')}"`;
      break;
    case 'push':
      command = 'git push';
      break;
    default:
      command = `git ${operation} ${args.join(' ')}`;
  }

  try {
    const { stdout, stderr } = await execAsync(command, { cwd: workDir, shell: true });
    res.json({ ok: true, stdout, stderr });
  } catch (err) {
    res.json({ ok: false, error: err.message, stdout: err.stdout, stderr: err.stderr });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Executor service running on port ${PORT}`));
