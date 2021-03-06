/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as childProcess from 'child_process';
import * as readline from 'readline';
import * as removeFolder from 'rimraf';
import * as stream from 'stream';
import { helper } from '../helper';
import { Progress } from '../progress';

export type Env = {[key: string]: string | number | boolean | undefined};

export type LaunchProcessOptions = {
  executablePath: string,
  args: string[],
  env?: Env,

  handleSIGINT?: boolean,
  handleSIGTERM?: boolean,
  handleSIGHUP?: boolean,
  pipe?: boolean,
  tempDirectories: string[],

  cwd?: string,

  // Note: attemptToGracefullyClose should reject if it does not close the browser.
  attemptToGracefullyClose: () => Promise<any>,
  onExit: (exitCode: number | null, signal: string | null) => void,
  progress: Progress,
};

type LaunchResult = {
  launchedProcess: childProcess.ChildProcess,
  gracefullyClose: () => Promise<void>,
  kill: () => Promise<void>,
};

export async function launchProcess(options: LaunchProcessOptions): Promise<LaunchResult> {
  const cleanup = () => helper.removeFolders(options.tempDirectories);

  const progress = options.progress;
  const stdio: ('ignore' | 'pipe')[] = options.pipe ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
  progress.logger.info(`<launching> ${options.executablePath} ${options.args.join(' ')}`);
  const spawnedProcess = childProcess.spawn(
      options.executablePath,
      options.args,
      {
        // On non-windows platforms, `detached: true` makes child process a leader of a new
        // process group, making it possible to kill child process tree with `.kill(-pid)` command.
        // @see https://nodejs.org/api/child_process.html#child_process_options_detached
        detached: process.platform !== 'win32',
        env: (options.env as {[key: string]: string}),
        cwd: options.cwd,
        stdio,
      }
  );
  if (!spawnedProcess.pid) {
    let failed: (e: Error) => void;
    const failedPromise = new Promise<Error>((f, r) => failed = f);
    spawnedProcess.once('error', error => {
      failed(new Error('Failed to launch browser: ' + error));
    });
    return cleanup().then(() => failedPromise).then(e => Promise.reject(e));
  }
  progress.logger.info(`<launched> pid=${spawnedProcess.pid}`);

  const stdout = readline.createInterface({ input: spawnedProcess.stdout });
  stdout.on('line', (data: string) => {
    progress.logger.info(data);
  });

  const stderr = readline.createInterface({ input: spawnedProcess.stderr });
  stderr.on('line', (data: string) => {
    progress.logger.warn(data);
  });

  let processClosed = false;
  let fulfillClose = () => {};
  const waitForClose = new Promise<void>(f => fulfillClose = f);
  let fulfillCleanup = () => {};
  const waitForCleanup = new Promise<void>(f => fulfillCleanup = f);
  spawnedProcess.once('exit', (exitCode, signal) => {
    progress.logger.info(`<process did exit: exitCode=${exitCode}, signal=${signal}>`);
    processClosed = true;
    helper.removeEventListeners(listeners);
    options.onExit(exitCode, signal);
    fulfillClose();
    // Cleanup as process exits.
    cleanup().then(fulfillCleanup);
  });

  const listeners = [ helper.addEventListener(process, 'exit', killProcess) ];
  if (options.handleSIGINT) {
    listeners.push(helper.addEventListener(process, 'SIGINT', () => {
      gracefullyClose().then(() => process.exit(130));
    }));
  }
  if (options.handleSIGTERM)
    listeners.push(helper.addEventListener(process, 'SIGTERM', gracefullyClose));
  if (options.handleSIGHUP)
    listeners.push(helper.addEventListener(process, 'SIGHUP', gracefullyClose));

  let gracefullyClosing = false;
  async function gracefullyClose(): Promise<void> {
    // We keep listeners until we are done, to handle 'exit' and 'SIGINT' while
    // asynchronously closing to prevent zombie processes. This might introduce
    // reentrancy to this function, for example user sends SIGINT second time.
    // In this case, let's forcefully kill the process.
    if (gracefullyClosing) {
      progress.logger.info(`<forecefully close>`);
      killProcess();
      await waitForClose;  // Ensure the process is dead and we called options.onkill.
      return;
    }
    gracefullyClosing = true;
    progress.logger.info(`<gracefully close start>`);
    await options.attemptToGracefullyClose().catch(() => killProcess());
    await waitForCleanup;  // Ensure the process is dead and we have cleaned up.
    progress.logger.info(`<gracefully close end>`);
  }

  // This method has to be sync to be used as 'exit' event handler.
  function killProcess() {
    progress.logger.info(`<kill>`);
    helper.removeEventListeners(listeners);
    if (spawnedProcess.pid && !spawnedProcess.killed && !processClosed) {
      // Force kill the browser.
      try {
        if (process.platform === 'win32')
          childProcess.execSync(`taskkill /pid ${spawnedProcess.pid} /T /F`);
        else
          process.kill(-spawnedProcess.pid, 'SIGKILL');
      } catch (e) {
        // the process might have already stopped
      }
    }
    try {
      // Attempt to remove temporary directories to avoid littering.
      for (const dir of options.tempDirectories)
        removeFolder.sync(dir);
    } catch (e) { }
  }

  function killAndWait() {
    killProcess();
    return waitForCleanup;
  }

  return { launchedProcess: spawnedProcess, gracefullyClose, kill: killAndWait };
}

export function waitForLine(progress: Progress, process: childProcess.ChildProcess, inputStream: stream.Readable, regex: RegExp): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: inputStream });
    const failError = new Error('Process failed to launch!');
    const listeners = [
      helper.addEventListener(rl, 'line', onLine),
      helper.addEventListener(rl, 'close', reject.bind(null, failError)),
      helper.addEventListener(process, 'exit', reject.bind(null, failError)),
      helper.addEventListener(process, 'error', reject.bind(null, failError))
    ];

    progress.cleanupWhenAborted(cleanup);

    function onLine(line: string) {
      const match = line.match(regex);
      if (!match)
        return;
      cleanup();
      resolve(match);
    }

    function cleanup() {
      helper.removeEventListeners(listeners);
    }
  });
}
