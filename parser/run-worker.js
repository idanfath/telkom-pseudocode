// Runs a program on a worker thread. The worker gets a bigger stack, so recursion reaches
// RECURSION_CAP (the main thread runs out at roughly half), and a long-running program
// does not freeze the VS Code extension host. Same result shape as runProgram.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const STACK_MB = 64;

if (!isMainThread && workerData && workerData.telkomRun) {
  const { runProgram } = require('./interpreter');
  parentPort.postMessage(runProgram(workerData.text, workerData.input, workerData.opts));
}

function runInWorker(text, input = '', opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const crash = (msg) => ({ output: [], error: { line: 0, msg }, staticErrors: null, leaks: 0 });
    let w;
    try {
      w = new Worker(__filename, { workerData: { telkomRun: true, text, input, opts }, resourceLimits: { stackSizeMb: STACK_MB } });
    } catch {
      return done(require('./interpreter').runProgram(text, input, opts)); // no worker support: run inline
    }
    w.once('message', done);
    w.once('error', (e) => done(crash('Interpreter crash: ' + (e && e.message))));
    w.once('exit', (code) => done(crash(`Runner stopped unexpectedly (exit ${code})`)));
  });
}

module.exports = { runInWorker };
