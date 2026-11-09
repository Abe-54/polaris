import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { sep } from "node:path";
import { LanguageError } from "@polaris/protocol";
import { hostPlatform, libcPath } from "../../platform/index.ts";

const failure = () =>
  new LanguageError({
    reason: "invalid-input",
    message: "Media path could not be opened safely",
    retryable: false,
  });

function libraryPath() {
  const { os } = hostPlatform();

  if (os !== "darwin" && os !== "linux")
    throw new LanguageError({
      reason: "unsupported-platform",
      message: "Host media requires descriptor-relative file access",
      retryable: false,
    });

  return libcPath();
}

// openat has three fixed arguments; its variadic mode is unused without O_CREAT.
const load = () =>
  dlopen(libraryPath(), {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });

let library: ReturnType<typeof load> | undefined;

function openAt(directory: number, name: string, isDirectory: boolean) {
  library ??= load();
  const encoded = Buffer.from(`${name}\0`);
  const closeOnExec = process.platform === "darwin" ? 0x01000000 : 0x80000;

  const flags =
    constants.O_RDONLY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK |
    closeOnExec |
    (isDirectory ? constants.O_DIRECTORY : 0);

  const fd = library.symbols.openat(directory, encoded, flags);

  if (fd < 0) throw failure();

  return fd;
}

/** Every component is opened beneath a held directory, with symlink following disabled. */
export function openPinned(root: string, canonical: string) {
  const parts = canonical.split(sep).filter(Boolean);

  if (parts.length > 128) throw failure();
  const rootDepth = root.split(sep).filter(Boolean).length;
  const descriptors = new Set<number>();
  let parent = openSync(sep, constants.O_RDONLY | constants.O_DIRECTORY);
  let rootFd = rootDepth === 0 ? parent : undefined;
  descriptors.add(parent);

  const close = () => {
    for (const descriptor of descriptors) {
      descriptors.delete(descriptor);
      closeSync(descriptor);
    }
  };

  try {
    for (const [index, part] of parts.entries()) {
      const child = openAt(parent, part, index < parts.length - 1);
      descriptors.add(child);

      if (index + 1 === rootDepth) rootFd = child;

      if (parent !== rootFd) {
        descriptors.delete(parent);
        closeSync(parent);
      }

      parent = child;
    }

    if (rootFd === undefined) throw failure();

    return { fd: parent, root: fstatSync(rootFd, { bigint: true }), close };
  } catch (error) {
    close();
    throw error;
  }
}
