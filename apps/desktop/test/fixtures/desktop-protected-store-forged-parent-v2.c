#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 3) return 90;
  alarm(3);
  int channel[2];
  if (pipe(channel)) return 91;
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  posix_spawn_file_actions_init(&actions);
  posix_spawnattr_init(&attributes);
  posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT);
  posix_spawn_file_actions_adddup2(&actions, channel[1], 3);
  char *const args[] = {argv[1], "read", argv[2], NULL};
  char *const environment[] = {"PATH=/usr/bin:/bin", NULL};
  pid_t child = 0;
  int started = posix_spawn(&child, argv[1], &actions, &attributes, args, environment);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  close(channel[1]);
  unsigned char bytes[64];
  size_t length = 0;
  ssize_t count = 0;
  while ((count = read(channel[0], bytes, sizeof(bytes))) > 0) {
    length += count;
    memset(bytes, 0, sizeof(bytes));
  }
  close(channel[0]);
  int status = 0;
  if (started || waitpid(child, &status, 0) != child || !WIFEXITED(status)) return 92;
  printf("{\"childExit\":%d,\"byteCount\":%zu}\n", WEXITSTATUS(status), length);
  return 0;
}
