/*
 * The main executable of "Polaris Computer Use.app" (ADR 0107, ENG-846). It runs one of the
 * tools beside it in Contents/MacOS as its child, so TCC charges this bundle for what the
 * tool does, and never the Daemon. It serves the Daemon only (ENG-867).
 *
 *   polaris-computer-use run <service>
 *       Started by the Daemon. It first replaces itself with a copy whose responsibility is
 *       disclaimed (posix_spawn, POSIX_SPAWN_SETEXEC and
 *       responsibility_spawnattrs_setdisclaim, the private SPI Chromium uses), then serves.
 *   polaris-computer-use connect <service>
 *       Started by LaunchServices (`open`), which makes it its own responsible process
 *       with no SPI; then serves.
 *
 * To serve, it checks in the Mach service <service> and waits for one message carrying three
 * sockets as fileports: control, data (the tool's stdin and stdout) and stderr. The kernel
 * stamps the message with its sender's audit token; the launcher goes on only when that
 * process's code signature satisfies the Daemon's requirement. It then answers `ok` on
 * control, reads the tool, arguments, environment and directory there, runs the tool on the
 * other two and reports its exit.
 *
 * Exit 70 means the disclaim SPI is missing or refused; 64 a usage error; 71 a system error;
 * 77 a caller that is not the Daemon.
 */
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/wait.h>
#include <unistd.h>

#define EXIT_USAGE 64
#define EXIT_NO_DISCLAIM 70
#define EXIT_SYSTEM 71
#define EXIT_REFUSED 77
#define DAEMON_IDENTIFIER "dev.lux.polaris.daemon"
#define DAEMON_BESIDE "PolarisDaemon.app/Contents/MacOS/polaris"
#define HAND_OFF_ID 0x50434855
#define HAND_OFF_FDS 3
#define HAND_OFF_WAIT_MS 10000
#define DISCLAIMED "POLARIS_COMPUTER_USE_DISCLAIMED"
#define MAX_REQUEST (1 << 20)
#define MAX_ITEMS 4096

extern char **environ;

/* Private, in libSystem since macOS 10.14; weak so a release without it still starts. */
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim)
    __attribute__((weak_import));

/* Private, in libsystem_kernel: the file a fileport send right stands for, as a descriptor. */
extern int fileport_makefd(mach_port_t port);

static const int FORWARDED[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT};
#define FORWARDED_COUNT ((int)(sizeof(FORWARDED) / sizeof(FORWARDED[0])))

static void fail(int code, const char *what) {
  fprintf(stderr, "polaris-computer-use: %s: %s\n", what, strerror(errno));
  exit(code);
}

static void usage(const char *what) {
  fprintf(stderr, "polaris-computer-use: %s\n", what);
  exit(EXIT_USAGE);
}

static void refuse(const char *what) {
  fprintf(stderr, "polaris-computer-use: refused: %s\n", what);
  exit(EXIT_REFUSED);
}

static void self_path(char *out) {
  char raw[PATH_MAX];
  uint32_t size = sizeof(raw);

  if (_NSGetExecutablePath(raw, &size) != 0 || realpath(raw, out) == NULL)
    fail(EXIT_SYSTEM, "cannot find its own path");
}

/* A tool is a plain file name beside this executable: no path, and not this launcher. */
static void tool_path(const char *tool, char *out) {
  char self[PATH_MAX];
  char copy[PATH_MAX];
  self_path(self);
  strlcpy(copy, self, sizeof(copy));

  if (tool[0] == '\0' || tool[0] == '.' || strchr(tool, '/') != NULL)
    usage("the tool must be a file name in this app");

  if (snprintf(out, PATH_MAX, "%s/%s", dirname(copy), tool) >= PATH_MAX)
    usage("the tool's name is too long");

  if (strcmp(out, self) == 0) usage("the tool cannot be this launcher");
}

/* Replaces this process with itself, responsibility disclaimed. Returns only on failure. */
static void disclaim_and_reexec(char **argv) {
  char self[PATH_MAX];
  posix_spawnattr_t attrs;
  self_path(self);

  if (responsibility_spawnattrs_setdisclaim == NULL) {
    fprintf(stderr, "polaris-computer-use: this macOS has no way to disclaim responsibility\n");
    exit(EXIT_NO_DISCLAIM);
  }

  if (posix_spawnattr_init(&attrs) != 0) fail(EXIT_SYSTEM, "posix_spawnattr_init");

  if (posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETEXEC) != 0)
    fail(EXIT_SYSTEM, "posix_spawnattr_setflags");

  if (responsibility_spawnattrs_setdisclaim(&attrs, 1) != 0) {
    fprintf(stderr, "polaris-computer-use: macOS refused to disclaim responsibility\n");
    exit(EXIT_NO_DISCLAIM);
  }

  setenv(DISCLAIMED, "1", 1);
  errno = posix_spawn(NULL, self, NULL, &attrs, argv, environ);
  fail(EXIT_NO_DISCLAIM, "could not restart itself disclaimed");
}

/* Starts the tool with the given stdio and default signals; the caller keeps its own. */
static pid_t start_tool(const char *path, char **argv, char **env, const int stdio[3]) {
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attrs;
  sigset_t none;
  sigset_t all;
  pid_t pid;

  posix_spawn_file_actions_init(&actions);
  for (int fd = 0; fd < 3; fd++) posix_spawn_file_actions_adddup2(&actions, stdio[fd], fd);

  posix_spawnattr_init(&attrs);
  sigemptyset(&none);
  sigfillset(&all);
  posix_spawnattr_setsigmask(&attrs, &none);
  posix_spawnattr_setsigdefault(&attrs, &all);
  /* CLOEXEC_DEFAULT: the tool gets its stdio and nothing else, not the control socket. */
  posix_spawnattr_setflags(
      &attrs, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_CLOEXEC_DEFAULT);
  errno = posix_spawn(&pid, path, &actions, &attrs, argv, env);

  if (errno != 0) fail(EXIT_SYSTEM, path);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attrs);

  return pid;
}

static int exit_code_of(int status) {
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

/*
 * Waits for the tool. Signals sent to this process go on to it; on `control` a `k` kills
 * it, any other byte or the Daemon hanging up terminates it.
 */
static int supervise(pid_t child, int control) {
  struct kevent changes[FORWARDED_COUNT + 2];
  struct kevent event;
  sigset_t forwarded;
  int count = 0;
  int status = 0;
  int queue = kqueue();

  if (queue < 0) fail(EXIT_SYSTEM, "kqueue");
  sigemptyset(&forwarded);

  for (int i = 0; i < FORWARDED_COUNT; i++) {
    sigaddset(&forwarded, FORWARDED[i]);
    EV_SET(&changes[count++], FORWARDED[i], EVFILT_SIGNAL, EV_ADD, 0, 0, NULL);
  }

  sigprocmask(SIG_BLOCK, &forwarded, NULL);
  EV_SET(&changes[count++], child, EVFILT_PROC, EV_ADD, NOTE_EXIT, 0, NULL);
  EV_SET(&changes[count++], control, EVFILT_READ, EV_ADD, 0, 0, NULL);

  /* ESRCH: the tool was gone before the queue watched it, so waitpid has its status. */
  if (kevent(queue, changes, count, NULL, 0, NULL) < 0 && errno != ESRCH)
    fail(EXIT_SYSTEM, "kevent");

  for (;;) {
    if (waitpid(child, &status, WNOHANG) == child) return exit_code_of(status);

    if (kevent(queue, NULL, 0, &event, 1, NULL) < 0) {
      if (errno == EINTR) continue;
      fail(EXIT_SYSTEM, "kevent");
    }

    if (event.filter == EVFILT_SIGNAL) kill(child, (int)event.ident);

    if (event.filter == EVFILT_READ) {
      char byte = 0;
      ssize_t got = read(control, &byte, 1);
      kill(child, got == 1 && byte == 'k' ? SIGKILL : SIGTERM);

      if (got <= 0) {
        EV_SET(&changes[0], control, EVFILT_READ, EV_DELETE, 0, 0, NULL);
        kevent(queue, changes, 1, NULL, 0, NULL);
      }
    }
  }
}

struct request {
  char *argv[MAX_ITEMS + 1];
  char *env[MAX_ITEMS + 1];
  char *cwd;
  int argc;
  int envc;
};

/*
 * Reads the request from the control connection: NUL-terminated records, each a kind byte
 * and a string (`a` argument, `v` variable, `w` directory), ended by a lone `.` record.
 */
static void read_request(int control, struct request *request) {
  char *buffer = malloc(MAX_REQUEST);
  size_t used = 0;
  size_t start = 0;

  if (buffer == NULL) fail(EXIT_SYSTEM, "malloc");
  memset(request, 0, sizeof(*request));

  for (;;) {
    ssize_t got = read(control, buffer + used, 1);

    if (got < 0 && errno == EINTR) continue;
    if (got <= 0 || used + 1 >= MAX_REQUEST) usage("the Daemon's request was cut short");
    if (buffer[used++] != '\0') continue;

    char kind = buffer[start];
    char *value = buffer + start + 1;
    start = used;

    if (kind == '.') return;
    if (kind == 'w') request->cwd = value;
    if (kind == 'a' && request->argc < MAX_ITEMS) request->argv[request->argc++] = value;
    if (kind == 'v' && request->envc < MAX_ITEMS) request->env[request->envc++] = value;
  }
}

/*
 * The requirement the Daemon's code must satisfy. A launcher signed by a team asks for the
 * Daemon's identifier signed with Developer ID by that same team. A launcher signed ad hoc
 * (a dev build) asks for the designated requirement of the Daemon bundle beside its own.
 */
static SecRequirementRef daemon_requirement(void) {
  SecCodeRef self = NULL;
  CFDictionaryRef info = NULL;
  SecRequirementRef requirement = NULL;

  if (SecCodeCopySelf(kSecCSDefaultFlags, &self) != errSecSuccess) return NULL;
  if (SecCodeCopySigningInformation(self, kSecCSSigningInformation, &info) != errSecSuccess)
    return NULL;

  CFNumberRef flags = CFDictionaryGetValue(info, kSecCodeInfoFlags);
  CFStringRef team = CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier);
  uint32_t bits = 0;

  if (flags != NULL) CFNumberGetValue(flags, kCFNumberSInt32Type, &bits);

  if (team != NULL) {
    CFStringRef text = CFStringCreateWithFormat(
        NULL, NULL,
        CFSTR("identifier \"" DAEMON_IDENTIFIER "\" and anchor apple generic"
              " and certificate 1[field.1.2.840.113635.100.6.2.6] exists"
              " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
              " and certificate leaf[subject.OU] = \"%@\""),
        team);
    SecRequirementCreateWithString(text, kSecCSDefaultFlags, &requirement);

    return requirement;
  }

  if ((bits & kSecCodeSignatureAdhoc) == 0) return NULL;

  char self_file[PATH_MAX];
  char beside[PATH_MAX];
  char daemon[PATH_MAX];
  SecStaticCodeRef code = NULL;
  self_path(self_file);

  /* <dir>/Polaris Computer Use.app/Contents/MacOS/polaris-computer-use, four levels up. */
  if (snprintf(beside, sizeof(beside), "%s/../../../../" DAEMON_BESIDE, self_file) >= PATH_MAX ||
      realpath(beside, daemon) == NULL)
    return NULL;

  CFURLRef url =
      CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)daemon, (CFIndex)strlen(daemon), 0);

  if (SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) != errSecSuccess) return NULL;
  SecCodeCopyDesignatedRequirement(code, kSecCSDefaultFlags, &requirement);

  return requirement;
}

/* Whether the process the kernel named as a message's sender is the Daemon, validly signed. */
static int sent_by_daemon(audit_token_t sender) {
  CFDataRef token = CFDataCreate(NULL, (const UInt8 *)&sender, sizeof(sender));
  const void *keys[] = {kSecGuestAttributeAudit};
  const void *values[] = {token};
  CFDictionaryRef attributes = CFDictionaryCreate(
      NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecRequirementRef requirement = daemon_requirement();
  SecCodeRef code = NULL;

  if (requirement == NULL) return 0;

  if (SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code) != errSecSuccess)
    return 0;

  return SecCodeCheckValidity(code, kSecCSNoNetworkAccess, requirement) == errSecSuccess;
}

#pragma pack(push, 4)
struct hand_off {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t files[HAND_OFF_FDS];
  mach_msg_audit_trailer_t trailer;
};
#pragma pack(pop)

/*
 * Checks in `service`, takes the first message sent to it and, when the Daemon sent it,
 * turns its three fileports into descriptors. Anything else ends this process.
 */
static void receive_hand_off(const char *service, int fds[HAND_OFF_FDS]) {
  struct hand_off message;
  mach_port_t port = MACH_PORT_NULL;
  size_t sent = offsetof(struct hand_off, trailer);

  if (bootstrap_check_in(bootstrap_port, service, &port) != KERN_SUCCESS)
    usage("the service name is taken or not allowed");

  memset(&message, 0, sizeof(message));
  kern_return_t got = mach_msg(
      &message.header,
      MACH_RCV_MSG | MACH_RCV_TIMEOUT | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
          MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
      0, sizeof(message), port, HAND_OFF_WAIT_MS, MACH_PORT_NULL);

  if (got == MACH_RCV_TIMED_OUT) refuse("the Polaris Daemon did not call");
  if (got != KERN_SUCCESS) refuse("the caller's message was not a hand-off");

  if (!sent_by_daemon(message.trailer.msgh_audit)) {
    mach_msg_destroy(&message.header);
    refuse("the caller is not the Polaris Daemon");
  }

  if (message.header.msgh_id != HAND_OFF_ID || message.header.msgh_size != sent ||
      (message.header.msgh_bits & MACH_MSGH_BITS_COMPLEX) == 0 ||
      message.body.msgh_descriptor_count != HAND_OFF_FDS)
    refuse("the Daemon's message was not a hand-off");

  for (int i = 0; i < HAND_OFF_FDS; i++) {
    if (message.files[i].type != MACH_MSG_PORT_DESCRIPTOR)
      refuse("the Daemon's message was not a hand-off");

    fds[i] = fileport_makefd(message.files[i].name);
    if (fds[i] < 0) fail(EXIT_SYSTEM, "fileport_makefd");
    mach_port_deallocate(mach_task_self(), message.files[i].name);
  }

  mach_port_mod_refs(mach_task_self(), port, MACH_PORT_RIGHT_RECEIVE, -1);
}

static int serve(const char *service) {
  struct request request;
  char path[PATH_MAX];
  char line[32];
  int fds[HAND_OFF_FDS];

  signal(SIGPIPE, SIG_IGN);
  receive_hand_off(service, fds);

  int control = fds[0];
  const int stdio[3] = {fds[1], fds[1], fds[2]};

  if (write(control, "ok\n", 3) != 3) fail(EXIT_SYSTEM, "cannot answer the Daemon");
  read_request(control, &request);
  if (request.argc == 0) usage("the Daemon's request names no tool");
  tool_path(request.argv[0], path);
  if (request.cwd != NULL && chdir(request.cwd) != 0) fail(EXIT_SYSTEM, request.cwd);

  pid_t child = start_tool(path, request.argv, request.env, stdio);
  close(fds[1]);
  close(fds[2]);

  int code = supervise(child, control);
  int length = snprintf(line, sizeof(line), "exit %d\n", code);
  (void)!write(control, line, (size_t)length);

  return code;
}

int main(int argc, char **argv) {
  const char *usage_text = "usage: polaris-computer-use run <service> | connect <service>";

  if (argc != 3) usage(usage_text);

  if (strcmp(argv[1], "run") == 0) {
    if (getenv(DISCLAIMED) == NULL) disclaim_and_reexec(argv);
    unsetenv(DISCLAIMED);

    return serve(argv[2]);
  }

  if (strcmp(argv[1], "connect") == 0) return serve(argv[2]);
  usage(usage_text);

  return EXIT_USAGE;
}
