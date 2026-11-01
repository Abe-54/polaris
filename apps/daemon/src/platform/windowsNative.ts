/**
 * The Win32 calls the Codex app-server needs and Bun doesn't expose: the TCP listener
 * table, a process's creation time, a child started inside a kill-on-close Job Object,
 * and files created with their security descriptor. Loaded on first use, Windows only.
 * See docs/adr/0061-windows-process-trees.md.
 */
import { dlopen, ptr, read } from "bun:ffi";
import { renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { currentUserSid } from "../transport/windowsPipe/win32.ts";
import {
  environmentBlock,
  type Listener,
  parseJobPids,
  parseTcpListeners,
  privateSddl,
  windowsCommandLine,
} from "./windowsLayout.ts";
import { system32 } from "./processes.ts";

/** A Win32 `HANDLE`, as Bun's FFI passes a `u64`. */
type Handle = bigint;

const INVALID_HANDLE: Handle = 0xffff_ffff_ffff_ffffn;

const open = () => ({
  kernel32: dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    LocalFree: { args: ["u64"], returns: "u64" },
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
    SetInformationJobObject: { args: ["u64", "u32", "ptr", "u32"], returns: "i32" },
    AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
    QueryInformationJobObject: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    TerminateJobObject: { args: ["u64", "u32"], returns: "i32" },
    TerminateProcess: { args: ["u64", "u32"], returns: "i32" },
    ResumeThread: { args: ["u64"], returns: "u32" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
    CreateProcessW: {
      args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"],
      returns: "i32",
    },
    InitializeProcThreadAttributeList: { args: ["ptr", "u32", "u32", "ptr"], returns: "i32" },
    UpdateProcThreadAttribute: {
      args: ["ptr", "u32", "u64", "ptr", "u64", "ptr", "ptr"],
      returns: "i32",
    },
    DeleteProcThreadAttributeList: { args: ["ptr"], returns: "void" },
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    WriteFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    CreateDirectoryW: { args: ["ptr", "ptr"], returns: "i32" },
    CreateToolhelp32Snapshot: { args: ["u32", "u32"], returns: "u64" },
    Process32FirstW: { args: ["u64", "ptr"], returns: "i32" },
    Process32NextW: { args: ["u64", "ptr"], returns: "i32" },
  }),
  advapi32: dlopen("advapi32.dll", {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: ["ptr", "u32", "ptr", "ptr"],
      returns: "i32",
    },
    GetNamedSecurityInfoW: {
      args: ["ptr", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"],
      returns: "u32",
    },
    ConvertSidToStringSidW: { args: ["u64", "ptr"], returns: "i32" },
    SetFileSecurityW: { args: ["ptr", "u32", "u64"], returns: "i32" },
  }),
  ntdll: dlopen("ntdll.dll", {
    NtQueryInformationProcess: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "u32" },
  }),
  iphlpapi: dlopen("iphlpapi.dll", {
    GetExtendedTcpTable: { args: ["ptr", "ptr", "i32", "u32", "u32", "u32"], returns: "u32" },
  }),
});

let lib: ReturnType<typeof open> | undefined;

const k32 = () => (lib ??= open()).kernel32.symbols;

const adv = () => (lib ??= open()).advapi32.symbols;

const ip = () => (lib ??= open()).iphlpapi.symbols;

const nt = () => (lib ??= open()).ntdll.symbols;

const wide = (value: string): Buffer => Buffer.from(`${value}\0`, "utf16le");

const failed = (call: string) => new Error(`${call} failed (Win32 error ${k32().GetLastError()})`);

const readWide = (address: bigint): string => {
  let out = "";

  for (let offset = 0; ; offset += 2) {
    // SAFETY: `address` is a NUL-terminated UTF-16 string the call just returned.
    const unit = read.u16(Number(address), offset);

    if (unit === 0) return out;
    out += String.fromCharCode(unit);
  }
};

const AF_INET = 2;

const TCP_TABLE_OWNER_PID_LISTENER = 3;

const ERROR_INSUFFICIENT_BUFFER = 122;

/** The 127.0.0.1 TCP listeners and their pids, from one `GetExtendedTcpTable` call. */
export const loopbackListeners = (): ReadonlyArray<Listener> => {
  const size = new Uint32Array(1);
  let code = ip().GetExtendedTcpTable(null, size, 0, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);

  // The table can grow between the sizing call and the read: retry with the new size.
  for (let attempt = 0; attempt < 4 && code === ERROR_INSUFFICIENT_BUFFER; attempt++) {
    const table = new Uint8Array(size[0]! + 1024);
    size[0] = table.byteLength;
    code = ip().GetExtendedTcpTable(table, size, 0, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);

    if (code === 0) return parseTcpListeners(new DataView(table.buffer));
  }

  if (code !== 0) throw new Error(`GetExtendedTcpTable failed (Win32 error ${code})`);

  return [];
};

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** Creation and exit times (FILETIMEs) of the process `handle` names. */
const timesOf = (handle: Handle): { created: bigint; exited: bigint } | null => {
  const [created, exited, kernel, user] = [0, 1, 2, 3].map(() => new BigUint64Array(1));

  if (!k32().GetProcessTimes(handle, created!, exited!, kernel!, user!)) return null;

  return { created: created![0]!, exited: exited![0]! };
};

/** When the running process `pid` was created (a FILETIME), or null if it is gone or not ours to ask. */
export const processCreated = (pid: number): bigint | null => {
  const handle = k32().OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);

  if (handle === 0n) return null;

  try {
    const times = timesOf(handle);

    return times === null || times.exited !== 0n ? null : times.created;
  } finally {
    k32().CloseHandle(handle);
  }
};

const PROCESS_COMMAND_LINE_INFORMATION = 60;

const STATUS_INFO_LENGTH_MISMATCH = 0xc000_0004;

/** `handle`'s command line: a `UNICODE_STRING` whose characters follow it in `buffer`. */
const queryCommandLine = (handle: Handle, buffer: Uint8Array, size: Uint32Array): number =>
  nt().NtQueryInformationProcess(
    handle,
    PROCESS_COMMAND_LINE_INFORMATION,
    buffer,
    buffer.byteLength,
    size
  );

/** The command line `pid` was started with, or null if it is gone or not ours to ask. */
export const processCommandLine = (pid: number): string | null => {
  const handle = k32().OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);

  if (handle === 0n) return null;

  try {
    const size = new Uint32Array(1);
    let buffer = new Uint8Array(4096);
    let status = queryCommandLine(handle, buffer, size);

    if (status === STATUS_INFO_LENGTH_MISMATCH) {
      buffer = new Uint8Array(size[0]!);
      status = queryCommandLine(handle, buffer, size);
    }

    if (status !== 0) return null;
    const view = new DataView(buffer.buffer);
    const length = view.getUint16(0, true);
    const offset = Number(view.getBigUint64(8, true) - BigInt(ptr(buffer)));

    return Buffer.from(buffer.buffer, offset, length).toString("utf16le");
  } finally {
    k32().CloseHandle(handle);
  }
};

const TH32CS_SNAPPROCESS = 2;

/** `PROCESSENTRY32W` on x64: pid at 8, parent pid at 32, `szExeFile[260]` at 44. */
const PROCESS_ENTRY_SIZE = 568;

/** The running processes `parent` started, with their executable names, from one kernel snapshot. */
export const childProcesses = (
  parent: number
): ReadonlyArray<{ readonly pid: number; readonly exe: string }> => {
  const snapshot = k32().CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);

  if (snapshot === INVALID_HANDLE) throw failed("CreateToolhelp32Snapshot");

  try {
    const entry = new Uint8Array(PROCESS_ENTRY_SIZE);
    const view = new DataView(entry.buffer);
    view.setUint32(0, PROCESS_ENTRY_SIZE, true);
    const children: Array<{ pid: number; exe: string }> = [];

    for (let ok = k32().Process32FirstW(snapshot, entry); ok;) {
      if (view.getUint32(32, true) === parent) {
        const name = Buffer.from(entry.buffer, 44, 520).toString("utf16le");
        children.push({ pid: view.getUint32(8, true), exe: name.slice(0, name.indexOf("\0")) });
      }

      ok = k32().Process32NextW(snapshot, entry);
    }

    return children;
  } finally {
    k32().CloseHandle(snapshot);
  }
};

/** Runs `body` with a `SECURITY_ATTRIBUTES` for `sddl` (null: none), freeing the descriptor after. */
const withAttributes = <A>(
  sddl: string | null,
  inherit: boolean,
  body: (attributes: BigUint64Array) => A
): A => {
  const descriptor = new BigUint64Array(1);

  if (
    sddl !== null &&
    !adv().ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl), 1, descriptor, null)
  )
    throw failed("ConvertStringSecurityDescriptorToSecurityDescriptorW");

  try {
    // { DWORD nLength; LPVOID lpSecurityDescriptor; BOOL bInheritHandle } is 24 bytes on x64.
    const attributes = new BigUint64Array([24n, descriptor[0]!, inherit ? 1n : 0n]);

    return body(attributes);
  } finally {
    if (descriptor[0] !== 0n) k32().LocalFree(descriptor[0]!);
  }
};

let userSid: string | undefined;

/** This process's user SID, read from its token once. */
export const thisUserSid = (): string => (userSid ??= currentUserSid());

const SE_FILE_OBJECT = 1;

const OWNER_SECURITY_INFORMATION = 0x1;

/** The owner SID of the file or directory at `path`; null when it can't be read. */
export const ownerOf = (path: string): string | null => {
  const owner = new BigUint64Array(1);
  const descriptor = new BigUint64Array(1);
  const SI = OWNER_SECURITY_INFORMATION;

  if (
    adv().GetNamedSecurityInfoW(
      wide(path),
      SE_FILE_OBJECT,
      SI,
      owner,
      null,
      null,
      null,
      descriptor
    ) !== 0
  )
    return null;

  try {
    const text = new BigUint64Array(1);

    if (!adv().ConvertSidToStringSidW(owner[0]!, text)) return null;
    const sid = readWide(text[0]!);
    k32().LocalFree(text[0]!);

    return sid;
  } finally {
    k32().LocalFree(descriptor[0]!);
  }
};

const DACL_SECURITY_INFORMATION = 0x4;

const PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;

/** Replaces `path`'s DACL with the user's entry alone, protected from inheritance; false if refused. */
export const setPrivateDacl = (path: string, kind: "directory" | "file"): boolean =>
  withAttributes(
    privateSddl(thisUserSid(), kind),
    false,
    (attributes) =>
      adv().SetFileSecurityW(
        wide(path),
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        attributes[1]!
      ) !== 0
  );

const ERROR_ALREADY_EXISTS = 183;

/** Creates `path` owned by the user and open to them alone; false if it already exists. */
export const createPrivateDirectory = (path: string): boolean =>
  withAttributes(privateSddl(thisUserSid(), "directory"), false, (attributes) => {
    if (k32().CreateDirectoryW(wide(path), attributes)) return true;

    if (k32().GetLastError() === ERROR_ALREADY_EXISTS) return false;
    throw failed("CreateDirectoryW");
  });

const GENERIC_READ = 0x8000_0000;

const GENERIC_WRITE = 0x4000_0000;

const CREATE_NEW = 1;

const OPEN_EXISTING = 3;

const OPEN_ALWAYS = 4;

const FILE_ATTRIBUTE_NORMAL = 0x80;

/** A new file at `path` holding `data`, owned by the user and open to them alone from its creation. */
const createPrivateFile = (path: string, data: string) =>
  withAttributes(privateSddl(thisUserSid(), "file"), false, (attributes) => {
    const handle = k32().CreateFileW(
      wide(path),
      GENERIC_WRITE,
      0,
      attributes,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL,
      0n
    );

    if (handle === INVALID_HANDLE) throw failed("CreateFileW");

    try {
      const bytes = Buffer.from(data, "utf8");
      const written = new Uint32Array(1);

      if (bytes.length > 0 && !k32().WriteFile(handle, bytes, bytes.length, written, null))
        throw failed("WriteFile");
    } finally {
      k32().CloseHandle(handle);
    }
  });

/** Writes `path` atomically: a fresh private file under a random name, renamed into place. */
export const writePrivateFile = (path: string, data: string): void => {
  const temporary = `${path}.${randomBytes(8).toString("hex")}`;

  createPrivateFile(temporary, data);

  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
};

/** A child started inside its own Job Object; closing the job, or the Daemon dying, ends all of it. */
export interface JobProcess {
  readonly pid: number;
  /** Its creation time, read through the handle held for its whole life. */
  readonly created: bigint;
  /** Every process in the job now: the child and all it started. */
  readonly pids: () => ReadonlyArray<number>;
  readonly alive: () => boolean;
  /** Ends every process in the job, waits up to 5 s for them to exit, and closes the handles. */
  readonly stop: () => Promise<void>;
}

const JobObjectBasicAccountingInformation = 1;

const JobObjectBasicProcessIdList = 3;

const JobObjectExtendedLimitInformation = 9;

const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

/** A job that kills what is in it when its last handle closes, and allows no breakaway. */
const createKillOnCloseJob = (): Handle => {
  const job = k32().CreateJobObjectW(null, null);

  if (job === 0n) throw failed("CreateJobObjectW");
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64; LimitFlags is at 16.
  const limits = new Uint8Array(144);
  new DataView(limits.buffer).setUint32(
    16,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    true
  );

  if (
    !k32().SetInformationJobObject(
      job,
      JobObjectExtendedLimitInformation,
      limits,
      limits.byteLength
    )
  ) {
    const error = failed("SetInformationJobObject");
    k32().CloseHandle(job);
    throw error;
  }

  return job;
};

const jobPids = (job: Handle): ReadonlyArray<number> => {
  const list = new Uint8Array(8 + 8 * 1024);

  if (
    !k32().QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, list.byteLength, null)
  )
    return [];

  return parseJobPids(new DataView(list.buffer));
};

const activeProcesses = (job: Handle): number => {
  // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: ActiveProcesses is the DWORD at 40 of 48.
  const info = new Uint8Array(48);

  if (
    !k32().QueryInformationJobObject(
      job,
      JobObjectBasicAccountingInformation,
      info,
      info.byteLength,
      null
    )
  )
    return 0;

  return new DataView(info.buffer).getUint32(40, true);
};

/** An inheritable handle to `path`, for a child's stdin (`NUL`, read) or log (append). */
const inheritableFile = (path: string, mode: "read" | "append"): Handle =>
  withAttributes(null, true, (attributes) => {
    // FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE: what `openSync(…, "a")` asks for.
    const access = mode === "read" ? GENERIC_READ : 0x4 | 0x80 | 0x10_0000;
    const share = 0x1 | 0x2 | 0x4;

    const handle = k32().CreateFileW(
      wide(path),
      access,
      share,
      attributes,
      mode === "read" ? OPEN_EXISTING : OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      0n
    );

    if (handle === INVALID_HANDLE) throw failed(`CreateFileW ${path}`);

    return handle;
  });

const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x2_0002;

/**
 * A `PROC_THREAD_ATTRIBUTE_LIST` that lets the child inherit `handles` and nothing else.
 * The list keeps a pointer to the handle values, so they live in its tail (ADR 0066).
 */
const handleList = (handles: ReadonlyArray<Handle>): Uint8Array => {
  const size = new BigUint64Array(1);
  k32().InitializeProcThreadAttributeList(null, 1, 0, size);
  const listBytes = Math.ceil(Number(size[0]!) / 8) * 8;
  // Over its own ArrayBuffer, so its storage never moves while Windows holds its address.
  const list = new Uint8Array(new ArrayBuffer(listBytes + 8 * handles.length));
  const values = new BigUint64Array(list.buffer, listBytes, handles.length);
  values.set(handles);

  if (!k32().InitializeProcThreadAttributeList(list, 1, 0, size))
    throw failed("InitializeProcThreadAttributeList");

  if (
    !k32().UpdateProcThreadAttribute(
      list,
      0,
      BigInt(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
      ptr(list, listBytes),
      BigInt(values.byteLength),
      null,
      null
    )
  ) {
    const error = failed("UpdateProcThreadAttribute");
    k32().DeleteProcThreadAttributeList(list);
    throw error;
  }

  return list;
};

const STARTF_USESHOWWINDOW = 0x1;

const STARTF_USESTDHANDLES = 0x100;

/** A `STARTUPINFOEXW` (112 bytes on x64): hidden, stdio from `stdin`/`log`, the handle list at 104. */
const startupInfo = (stdin: Handle, log: Handle, attributes: Uint8Array): Uint8Array => {
  const info = new Uint8Array(112);
  const view = new DataView(info.buffer);
  view.setUint32(0, info.byteLength, true);
  view.setUint32(60, STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, true);
  view.setUint16(64, 0, true); // SW_HIDE
  view.setBigUint64(80, stdin, true);
  view.setBigUint64(88, log, true);
  view.setBigUint64(96, log, true);
  view.setBigUint64(104, BigInt(ptr(attributes)), true);

  return info;
};

const CREATE_SUSPENDED = 0x4;

const CREATE_UNICODE_ENVIRONMENT = 0x400;

const EXTENDED_STARTUPINFO_PRESENT = 0x8_0000;

const CREATE_NO_WINDOW = 0x0800_0000;

interface Created {
  readonly process: Handle;
  readonly thread: Handle;
  readonly pid: number;
}

/** `CreateProcessW`, suspended and windowless, inheriting only its stdin and log handles. */
const createSuspended = (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  logFile: string
): Created => {
  const { application, commandLine } = windowsCommandLine(argv, system32("cmd.exe"));
  const stdin = inheritableFile("NUL", "read");
  const log = inheritableFile(logFile, "append");

  try {
    const attributes = handleList([stdin, log]);
    const info = new BigUint64Array(3);

    try {
      const flags =
        CREATE_SUSPENDED |
        CREATE_UNICODE_ENVIRONMENT |
        EXTENDED_STARTUPINFO_PRESENT |
        CREATE_NO_WINDOW;

      const startup = startupInfo(stdin, log, attributes);

      // Typed arrays, not ptr(): an argument stays alive until the call (ADR 0066).
      if (
        !k32().CreateProcessW(
          wide(application),
          wide(commandLine),
          null,
          null,
          1,
          flags,
          environmentBlock(env),
          null,
          startup,
          info
        )
      )
        throw failed("CreateProcessW");
    } finally {
      // Also what holds `attributes`, whose address `startup` carries, through the call.
      k32().DeleteProcThreadAttributeList(attributes);
    }

    return { process: info[0]!, thread: info[1]!, pid: Number(info[2]! & 0xffff_ffffn) };
  } finally {
    k32().CloseHandle(stdin);
    k32().CloseHandle(log);
  }
};

const WAIT_TIMEOUT = 0x102;

/**
 * Starts `argv` (a `.cmd` through cmd.exe) suspended, puts it in a new kill-on-close job,
 * then lets it run: nothing it starts can be outside the job. Its output is appended to `logFile`.
 */
export const spawnInJob = (options: {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logFile: string;
}): JobProcess => {
  const job = createKillOnCloseJob();
  let child: Created;

  try {
    child = createSuspended(options.argv, options.env, options.logFile);
  } catch (error) {
    k32().CloseHandle(job);
    throw error;
  }

  const { process: handle, thread, pid } = child;
  const times = timesOf(handle);

  if (
    !k32().AssignProcessToJobObject(job, handle) ||
    times === null ||
    k32().ResumeThread(thread) === 0xffff_ffff
  ) {
    const error = failed("starting the child in its job");
    k32().TerminateProcess(handle, 1);

    for (const each of [thread, handle, job]) k32().CloseHandle(each);
    throw error;
  }

  k32().CloseHandle(thread);
  let open = true;

  const stop = async () => {
    if (!open) return;
    open = false;
    k32().TerminateJobObject(job, 1);

    for (let waited = 0; waited < 5000 && activeProcesses(job) > 0; waited += 50)
      await Bun.sleep(50);
    k32().CloseHandle(handle);
    k32().CloseHandle(job);
  };

  return {
    pid,
    created: times.created,
    pids: () => (open ? jobPids(job) : []),
    alive: () => open && k32().WaitForSingleObject(handle, 0) === WAIT_TIMEOUT,
    stop,
  };
};
