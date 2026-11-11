// Runs a program on a worker thread. The worker has a bigger stack, so recursion reaches the
// runner's own depth limit, and a long or endless program never blocks the editor: it can
// simply be terminated.
//
//   runInWorker(text, input, opts)  -> Promise<result>     all input given up front
//   startRun(text, handlers, opts)  -> {sendLine, kill}    interactive: output arrives line by
//                                                          line, input is asked for when needed
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const STACK_MB = 64;
const LINE_BYTES = 64 * 1024;
// shared control words: [0] 0 = worker is waiting, 1 = a line is ready, 2 = no more input; [1] byte length
const WAITING = 0, READY = 1, CLOSED = 2;

if (!isMainThread && workerData && workerData.telkomRun) {
  const { runProgram } = require('./interpreter');
  const { text, input, opts, shared } = workerData;
  const io = {};
  if (shared) {
    const ctl = new Int32Array(shared, 0, 2);
    const bytes = new Uint8Array(shared, 8);
    io.onOutput = (line) => parentPort.postMessage({ type: 'out', line });
    io.readLine = () => { // blocks this thread until the main thread hands over a line
      Atomics.store(ctl, 0, WAITING);
      parentPort.postMessage({ type: 'need-input' });
      Atomics.wait(ctl, 0, WAITING);
      if (Atomics.load(ctl, 0) === CLOSED) return null;
      return Buffer.from(bytes.slice(0, Atomics.load(ctl, 1))).toString('utf8');
    };
  }
  parentPort.postMessage({ type: 'done', result: runProgram(text, input, { ...opts, ...io }) });
}

const crash = (msg) => ({ output: [], error: { line: 0, msg }, staticErrors: null, leaks: 0 });

function spawn(text, input, opts, shared) {
  return new Worker(__filename, { workerData: { telkomRun: true, text, input, opts, shared }, resourceLimits: { stackSizeMb: STACK_MB } });
}

function runInWorker(text, input = '', opts = {}) {
  return new Promise((resolve) => {
    let w;
    try { w = spawn(text, input, opts, null); }
    catch { resolve(require('./interpreter').runProgram(text, input, opts)); return; } // no worker support: run inline
    w.once('message', (m) => resolve(m.result));
    w.once('error', (e) => resolve(crash('Interpreter crash: ' + (e && e.message))));
    w.once('exit', (code) => resolve(crash(`Runner stopped unexpectedly (exit ${code})`)));
  });
}

/**
 * @param {string} text
 * @param {{onOutput: (line: string) => void, onNeedInput: () => void, onDone: (result: any) => void}} handlers
 *   onDone gets the run result, or null when the run was killed
 * @param {object} [opts] runProgram options
 * @returns {{sendLine: (line: string) => void, kill: () => void}}
 */
function startRun(text, handlers, opts = {}) {
  const shared = new SharedArrayBuffer(8 + LINE_BYTES);
  const ctl = new Int32Array(shared, 0, 2);
  const bytes = new Uint8Array(shared, 8);
  let finished = false;
  const finish = (result) => { if (!finished) { finished = true; handlers.onDone(result); } };
  const w = spawn(text, '', opts, shared);
  w.on('message', (m) => {
    if (finished) return;
    if (m.type === 'out') handlers.onOutput(m.line);
    else if (m.type === 'need-input') handlers.onNeedInput();
    else if (m.type === 'done') finish(m.result);
  });
  w.once('error', (e) => finish(crash('Interpreter crash: ' + (e && e.message))));
  w.once('exit', (code) => finish(crash(`Runner stopped unexpectedly (exit ${code})`)));
  const wake = (state) => { Atomics.store(ctl, 0, state); Atomics.notify(ctl, 0); };
  return {
    sendLine(line) {
      const data = Buffer.from(line, 'utf8').subarray(0, LINE_BYTES);
      bytes.set(data);
      Atomics.store(ctl, 1, data.length);
      wake(READY);
    },
    kill() {
      if (finished) return;
      finish(null);
      wake(CLOSED);
      w.terminate();
    },
  };
}

module.exports = { runInWorker, startRun };
