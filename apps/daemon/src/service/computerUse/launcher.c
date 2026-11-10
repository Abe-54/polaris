/*
 * The main executable of "Polaris Computer Use.app" (ADR 0104, ENG-846). It runs one of the
 * tools beside it in Contents/MacOS as its child, so TCC charges this bundle for what the
 * tool does, and never the Daemon.
 *
 *   polaris-computer-use run <tool> [args...]
 *       Started by the Daemon with stdio inherited. It first replaces itself with a copy
 *       whose responsibility is disclaimed (posix_spawn, POSIX_SPAWN_SETEXEC and
 *       responsibility_spawnattrs_setdisclaim, the private SPI Chromium uses), then runs
 *       the tool, forwards signals to it and exits with its status. SIGUSR1 kills the
 *       tool outright, since a SIGKILL sent to this process could not be passed on.
 *   polaris-computer-use connect <socket>
 *       Started by LaunchServices (`open`), which makes it its own responsible process
 *       with no SPI. It connects to the Daemon's Unix socket three times (control, data,
 *       stderr), reads the tool, arguments, environment and directory from the control
 *       connection, runs the tool on the other two and reports its exit there.
 *
 * Exit 70 means the disclaim SPI is missing or refused; 64 a usage error; 71 a system error.
 */
#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define EXIT_USAGE 64
#define EXIT_NO_DISCLAIM 70
#define EXIT_SYSTEM 71
#define DISCLAIMED "POLARIS_COMPUTER_USE_DISCLAIMED"
#define MAX_REQUEST (1 << 20)
#define MAX_ITEMS 4096

extern char **environ;

/* Private, in libSystem since macOS 10.14; weak so a release without it still starts. */
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim)
    __attribute__((weak_import));

static const int FORWARDED[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1};
#define FORWARDED_COUNT ((int)(sizeof(FORWARDED) / sizeof(FORWARDED[0])))

static void fail(int code, const char *what) {
  fprintf(stderr, "polaris-computer-use: %s: %s\n", what, strerror(errno));
  exit(code);
}

static void usage(const char *what) {
  fprintf(stderr, "polaris-computer-use: %s\n", what);
  exit(EXIT_USAGE);
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
  for (int fd = 0; fd < 3; fd++)
    if (stdio[fd] != fd) posix_spawn_file_actions_adddup2(&actions, stdio[fd], fd);

  posix_spawnattr_init(&attrs);
  sigemptyset(&none);
  sigfillset(&all);
  posix_spawnattr_setsigmask(&attrs, &none);
  posix_spawnattr_setsigdefault(&attrs, &all);
  posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
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
 * Waits for the tool. Signals sent to this process go on to it, SIGUSR1 as SIGKILL; on
 * `control` (when not -1)
 * a `k` kills it, any other byte or the Daemon hanging up terminates it.
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
  if (control >= 0) EV_SET(&changes[count++], control, EVFILT_READ, EV_ADD, 0, 0, NULL);

  /* ESRCH: the tool was gone before the queue watched it, so waitpid has its status. */
  if (kevent(queue, changes, count, NULL, 0, NULL) < 0 && errno != ESRCH)
    fail(EXIT_SYSTEM, "kevent");

  for (;;) {
    if (waitpid(child, &status, WNOHANG) == child) return exit_code_of(status);

    if (kevent(queue, NULL, 0, &event, 1, NULL) < 0) {
      if (errno == EINTR) continue;
      fail(EXIT_SYSTEM, "kevent");
    }

    if (event.filter == EVFILT_SIGNAL)
      kill(child, event.ident == SIGUSR1 ? SIGKILL : (int)event.ident);

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

static int run(int argc, char **argv) {
  static const int inherited[3] = {0, 1, 2};
  char path[PATH_MAX];

  if (argc < 3) usage("usage: polaris-computer-use run <tool> [args...]");

  if (getenv(DISCLAIMED) == NULL) disclaim_and_reexec(argv);
  unsetenv(DISCLAIMED);
  tool_path(argv[2], path);

  return supervise(start_tool(path, argv + 2, environ, inherited), -1);
}

/* One connection to the Daemon's socket, announced by its tag byte. */
static int dial(const char *socket_path, char tag) {
  struct sockaddr_un address;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);

  if (fd < 0) fail(EXIT_SYSTEM, "socket");
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;

  if (strlcpy(address.sun_path, socket_path, sizeof(address.sun_path)) >= sizeof(address.sun_path))
    usage("the socket's path is too long");

  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0)
    fail(EXIT_SYSTEM, "cannot reach the Daemon's socket");

  if (write(fd, &tag, 1) != 1) fail(EXIT_SYSTEM, "cannot write to the Daemon's socket");

  return fd;
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

static int serve(int argc, char **argv) {
  struct request request;
  char path[PATH_MAX];
  char line[32];

  if (argc != 3) usage("usage: polaris-computer-use connect <socket>");
  signal(SIGPIPE, SIG_IGN);

  int control = dial(argv[2], 'c');
  int data = dial(argv[2], 'd');
  int errors = dial(argv[2], 'e');
  const int stdio[3] = {data, data, errors};

  read_request(control, &request);
  if (request.argc == 0) usage("the Daemon's request names no tool");
  tool_path(request.argv[0], path);
  if (request.cwd != NULL && chdir(request.cwd) != 0) fail(EXIT_SYSTEM, request.cwd);

  pid_t child = start_tool(path, request.argv, request.env, stdio);
  close(data);
  close(errors);

  int code = supervise(child, control);
  int length = snprintf(line, sizeof(line), "exit %d\n", code);
  (void)!write(control, line, (size_t)length);

  return code;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "run") == 0) return run(argc, argv);
  if (argc >= 2 && strcmp(argv[1], "connect") == 0) return serve(argc, argv);
  usage("usage: polaris-computer-use run <tool> [args...] | connect <socket>");

  return EXIT_USAGE;
}
