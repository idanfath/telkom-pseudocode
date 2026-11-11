// One run of a program in a terminal: prints output as it happens, collects typed lines
// and hands them to input(). Knows nothing about VS Code; it only needs a write(data)
// function for terminal output and gets keystrokes through handleInput(data).
'use strict';
const { analyze } = require('./analyzer');
const { startRun } = require('./run-worker');

const RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

class RunSession {
  /**
   * @param {string} text program source
   * @param {(data: string) => void} write raw terminal output
   * @param {{onEnd?: (result: any) => void, opts?: object}} [options]
   */
  constructor(text, write, options = {}) {
    this.text = text;
    this.write = write;
    this.onEnd = options.onEnd || (() => {});
    this.opts = options.opts || {};
    this.running = false;
    this.waiting = false; // the program is blocked in input()
    this.line = ''; // what the user is typing
    this.queue = []; // finished lines the program has not read yet
    this.run = null;
  }

  start() {
    const errors = analyze(this.text).filter(d => d.sev === 0);
    if (errors.length) {
      this.write(`${RED}Cannot run: ${errors.length} error(s). Fix them first (see the Problems panel).${RESET}\r\n`);
      for (const d of errors.slice(0, 10)) this.write(`  line ${d.line + 1}: ${d.msg}\r\n`);
      if (errors.length > 10) this.write(`  ... and ${errors.length - 10} more\r\n`);
      this.onEnd({ output: [], error: null, staticErrors: errors, leaks: 0 });
      return;
    }
    this.running = true;
    this.run = startRun(this.text, {
      onOutput: (line) => this.write(crlf(line) + '\r\n'),
      onNeedInput: () => {
        this.waiting = true;
        if (this.queue.length) this.feed();
        else if (!this.line) this.write(`${DIM}> ${RESET}`);
      },
      onDone: (result) => this.finish(result),
    }, this.opts);
  }

  feed() {
    if (!this.waiting || !this.queue.length) return;
    this.waiting = false;
    this.run.sendLine(this.queue.shift());
  }

  finish(result) {
    if (!this.running) return;
    this.running = false;
    if (result && result.error) this.write(`${RED}Runtime error at line ${result.error.line + 1}: ${result.error.msg}${RESET}\r\n`);
    else if (result && result.staticErrors) this.write(`${RED}Cannot run: ${result.staticErrors.length} error(s).${RESET}\r\n`);
    else if (result) this.write(`${DIM}--- done ---${RESET}\r\n`);
    this.onEnd(result);
  }

  /** Keystrokes from the terminal. */
  handleInput(data) {
    if (!this.running) return;
    if (data.startsWith('\x1b')) return; // arrow keys and other escape sequences
    for (const ch of data.replace(/\r\n/g, '\r')) {
      if (ch === '\x03') { // Ctrl+C
        this.write('^C\r\n');
        this.kill();
        this.write(`${DIM}--- stopped ---${RESET}\r\n`);
        return;
      }
      if (ch === '\r' || ch === '\n') {
        this.write('\r\n');
        this.queue.push(this.line);
        this.line = '';
        this.feed();
      } else if (ch === '\x7f' || ch === '\b') {
        if (!this.line) continue;
        this.line = [...this.line].slice(0, -1).join('');
        this.write('\b \b');
      } else if (ch >= ' ' || ch === '\t') {
        this.line += ch;
        this.write(ch);
      }
    }
  }

  /** Stop the program, if it is still running. */
  kill() {
    if (this.run && this.running) this.run.kill();
  }
}

module.exports = { RunSession };
