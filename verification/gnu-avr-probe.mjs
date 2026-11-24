import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Assemble synthetic source for the A3. GDB starts its software simulator at the first instruction.
export function runAvrProbe(bin, profile, assembly, steps) {
  const privateRoot = realpathSync(fileURLToPath(new URL('../private/', import.meta.url)));
  const stage = mkdtempSync(join(privateRoot, profile + '-gnu-'));
  const path = file => join(stage, file);
  const command = (tool, args) => {
    const run = spawnSync(resolve(bin, tool + '.exe'), args, { cwd: stage, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (run.error) throw new Error(run.error.message + '\n' + (run.stdout ?? '') + (run.stderr ?? ''));
    if (run.status !== 0) throw new Error(tool + ' failed: ' + run.stdout + run.stderr);
    return run.stdout;
  };
  try {
    const gdb = ['set pagination off', 'set confirm off', 'target sim', 'load', 'break *_start', 'run', 'delete breakpoints', ...steps];
    writeFileSync(path('probe.s'), assembly.join('\n') + '\n');
    writeFileSync(path('probe.gdb'), gdb.join('\n') + '\n');
    command('avr-as', ['-mmcu=atxmega256a3', '-o', 'probe.o', 'probe.s']);
    command('avr-ld', ['-m', 'avrxmega6', '-e', '_start', '-Ttext=0', '-o', 'probe.elf', 'probe.o']);
    command('avr-objcopy', ['-O', 'binary', '-j', '.text', 'probe.elf', 'probe.bin']);
    const output = command('avr-gdb', ['-nx', '-q', '-batch', '-x', 'probe.gdb', 'probe.elf']);
    return { bytes: readFileSync(path('probe.bin')), output, assembler: command('avr-as', ['--version']).split(/\r?\n/)[0],
      simulator: command('avr-gdb', ['--version']).split(/\r?\n/)[0] };
  } finally {
    if (dirname(realpathSync(stage)) !== privateRoot) throw new Error('Unexpected synthetic staging path');
    for (const file of ['probe.s', 'probe.o', 'probe.elf', 'probe.bin', 'probe.gdb']) if (existsSync(path(file))) unlinkSync(path(file));
    rmdirSync(stage);
  }
}
