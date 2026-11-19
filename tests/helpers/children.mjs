/**
 * Children of a given pid, including zombies, without needing /proc on the host.
 *
 * Zombies are the leak that matters: they are gone from `cgroup.procs` and from
 * `docker top`, but still counted against pids.max. So the tests ask a process
 * "who are your children right now?" rather than looking at any of those.
 */
import childProcess from 'node:child_process';
import fs from 'node:fs';

function listFromProc(pid) {
  try {
    fs.readdirSync('/proc/self/fd');
  } catch {
    return null; // no /proc on this platform
  }
  const children = [];
  let tasks;
  try {
    tasks = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    return []; // process is gone
  }
  for (const tid of tasks) {
    let raw;
    try {
      raw = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf-8').trim();
    } catch {
      continue;
    }
    if (!raw) continue;
    for (const id of raw.split(/\s+/)) {
      try {
        const stat = fs.readFileSync(`/proc/${id}/stat`, 'utf-8');
        const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        children.push({
          pid: Number(id),
          state: after[0],
          comm: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')),
        });
      } catch {
        /* exited while we looked */
      }
    }
  }
  return children;
}

function listFromPs(pid) {
  // spawnSync so the sampler's own pid is known and excluded; otherwise `ps`
  // shows up as one of the children it is reporting.
  const { spawnSync } = childProcess;
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,stat=,comm='], { encoding: 'utf-8' });
  const sampler = result.pid;
  return (result.stdout ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [childPid, ppid, state, ...comm] = line.split(/\s+/);
      return { pid: Number(childPid), ppid: Number(ppid), state, comm: comm.join(' ') };
    })
    .filter(row => row.ppid === pid && row.pid !== sampler)
    .map(({ pid: childPid, state, comm }) => ({ pid: childPid, state, comm }));
}

export function listChildren(pid) {
  return listFromProc(pid) ?? listFromPs(pid);
}

export function zombiesOf(pid) {
  return listChildren(pid).filter(child => child.state.startsWith('Z'));
}

/**
 * Zombies reparented to `ppid` — in a container, that is PID 1, and a zombie
 * there is the leftover of a process that daemonised rather than one anybody
 * spawned. Returns null where /proc is unavailable.
 */
export function zombiesWithParent(ppid) {
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  const found = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf-8');
    } catch {
      continue;
    }
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (after[0] !== 'Z') continue;
    if (Number(after[1]) !== ppid) continue;
    found.push({
      pid: Number(entry),
      state: 'Z',
      comm: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')),
    });
  }
  return found;
}

/**
 * True when the given pid is running (not merely present as a zombie).
 * Used to prove a timeout took out a whole process group, not just its leader.
 */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code !== 'ESRCH';
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const after = stat.slice(stat.lastIndexOf(')') + 2);
    return !after.startsWith('Z');
  } catch {
    return true; // no /proc: trust the signal probe
  }
}

/** Wait (briefly) for a pid to disappear; resolves true if it did. */
export async function waitForExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}
