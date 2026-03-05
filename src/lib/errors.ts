export class pkglabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'pkglabError';
  }
}

export class DaemonNotRunningError extends pkglabError {
  constructor(msg = 'Registry is not running. Run: pkglab up') {
    super(msg);
    this.name = 'DaemonNotRunningError';
  }
}

export class DaemonAlreadyRunningError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = 'DaemonAlreadyRunningError';
  }
}

export class LockAcquisitionError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = 'LockAcquisitionError';
  }
}

export class CycleDetectedError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = 'CycleDetectedError';
  }
}

export class NpmrcConflictError extends pkglabError {
  constructor(msg: string) {
    super(msg);
    this.name = 'NpmrcConflictError';
  }
}

export class ListenerNotRunningError extends pkglabError {
  constructor(msg = 'No listener running for this workspace. Run: pkglab listen') {
    super(msg);
    this.name = 'ListenerNotRunningError';
  }
}

export class DaemonStartTimeoutError extends pkglabError {
  constructor(msg = 'Registry did not become ready (another process may have failed to start it)') {
    super(msg);
    this.name = 'DaemonStartTimeoutError';
  }
}

export class CommandError extends pkglabError {
  logged: boolean;

  constructor(message: string, opts?: { logged?: boolean }) {
    super(message);
    this.name = 'CommandError';
    this.logged = opts?.logged ?? false;
  }
}

export class SilentExitError extends pkglabError {
  exitCode: number;

  constructor(exitCode = 1) {
    super('');
    this.name = 'SilentExitError';
    this.exitCode = exitCode;
  }
}
