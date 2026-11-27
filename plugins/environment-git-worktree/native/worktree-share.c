#include <CommonCrypto/CommonDigest.h>
#include <copyfile.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/attr.h>
#include <sys/clonefile.h>
#include <sys/file.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <time.h>
#include <unistd.h>

#ifndef WORKTREE_SHARE_PHASE
#define WORKTREE_SHARE_PHASE(phase) ((void)(phase))
#endif

#define BATCH_SIZE 24
#define MAX_XATTR_BYTES (16 * 1024 * 1024)
#define JOURNAL_MAGIC UINT64_C(0x4f4d4e594f434f57)

typedef struct {
  uint64_t dev, ino, size;
  uint32_t uid, gid, mode, flags;
  int64_t birth_sec, birth_nsec, mtime_sec, mtime_nsec;
  int64_t atime_sec, atime_nsec, backup_sec, backup_nsec;
  unsigned char attributes[CC_SHA256_DIGEST_LENGTH];
} Metadata;

typedef struct {
  uint64_t magic, parent_dev, parent_ino, clone_ino;
  Metadata original;
  unsigned char contents[CC_SHA256_DIGEST_LENGTH];
  char target[PATH_MAX];
} Journal;

typedef struct {
  int parent, directory, original, clone;
  bool exchanged;
  char name[80], basename[NAME_MAX + 1];
  Journal journal;
} Pending;

typedef struct {
  uint64_t shared, released, skipped;
} Totals;

static volatile sig_atomic_t stopped;
static unsigned diagnostics;

static void stop_signal(int value) { stopped = value; }

static void diagnose(const char *message) {
  if (diagnostics++ < 12)
    fprintf(stderr, "worktree-share: %s\n", message);
}

static bool same_inode(const struct stat *st, uint64_t dev, uint64_t ino) {
  return (uint64_t)st->st_dev == dev && (uint64_t)st->st_ino == ino;
}

static bool valid_path(const char *path) {
  if (path[0] != '/' || strlen(path) >= PATH_MAX || !path[1])
    return false;
  const char *start = path + 1;
  for (const char *p = start;; p++) {
    if (*p != '/' && *p)
      continue;
    size_t length = (size_t)(p - start);
    if (!length || (length == 1 && start[0] == '.') ||
        (length == 2 && start[0] == '.' && start[1] == '.'))
      return false;
    if (!*p)
      return true;
    start = p + 1;
  }
}

static int open_parent(const char *path, char *basename) {
  if (!valid_path(path)) {
    errno = EINVAL;
    return -1;
  }
  char parent[PATH_MAX];
  memcpy(parent, path, strlen(path) + 1);
  char *slash = strrchr(parent, '/');
  if (strlen(slash + 1) > NAME_MAX) {
    errno = ENAMETOOLONG;
    return -1;
  }
  strcpy(basename, slash + 1);
  if (slash == parent)
    slash[1] = 0;
  else
    *slash = 0;
  return open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC);
}

static bool owned_regular(const struct stat *st) {
  return S_ISREG(st->st_mode) && st->st_nlink == 1 && st->st_uid == geteuid() &&
         !(st->st_mode & (S_IWGRP | S_IWOTH)) &&
         !(st->st_flags & (UF_IMMUTABLE | SF_IMMUTABLE | UF_APPEND | SF_APPEND |
                           UF_COMPRESSED | SF_DATALESS));
}

static bool sha_file(int fd, unsigned char digest[CC_SHA256_DIGEST_LENGTH]) {
  struct stat before, after;
  if (fstat(fd, &before) || before.st_size < 0)
    return false;
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  unsigned char bytes[65536];
  off_t offset = 0;
  while (offset < before.st_size) {
    size_t wanted = (uint64_t)(before.st_size - offset) < sizeof(bytes)
                        ? (size_t)(before.st_size - offset)
                        : sizeof(bytes);
    ssize_t count = pread(fd, bytes, wanted, offset);
    if (count < 0) {
      if (errno == EINTR)
        continue;
      return false;
    }
    if (!count)
      return false;
    CC_SHA256_Update(&context, bytes, (CC_LONG)count);
    offset += count;
  }
  if (fstat(fd, &after) || after.st_size != before.st_size)
    return false;
  CC_SHA256_Final(digest, &context);
  return true;
}

static int compare_names(const void *left, const void *right) {
  return strcmp(*(const char *const *)left, *(const char *const *)right);
}

static bool attribute_digest(int fd,
                             unsigned char digest[CC_SHA256_DIGEST_LENGTH]) {
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  ssize_t length = flistxattr(fd, NULL, 0, 0);
  if (length < 0 || length > MAX_XATTR_BYTES)
    return false;
  char *names = calloc((size_t)length + 1, 1);
  char **ordered = calloc((size_t)length + 1, sizeof(char *));
  if (!names || !ordered) {
    free(names);
    free(ordered);
    return false;
  }
  if (flistxattr(fd, names, (size_t)length, 0) != length) {
    free(names);
    free(ordered);
    return false;
  }
  size_t count = 0;
  for (ssize_t cursor = 0; cursor < length;) {
    size_t size = strnlen(names + cursor, (size_t)(length - cursor));
    if (!size || size >= (size_t)(length - cursor)) {
      free(names);
      free(ordered);
      return false;
    }
    ordered[count++] = names + cursor;
    cursor += (ssize_t)size + 1;
  }
  qsort(ordered, count, sizeof(char *), compare_names);
  bool ok = true;
  for (size_t i = 0; i < count && ok; i++) {
    ssize_t size = fgetxattr(fd, ordered[i], NULL, 0, 0, 0);
    if (size < 0 || size > MAX_XATTR_BYTES) {
      ok = false;
      break;
    }
    void *value = malloc((size_t)size + 1);
    if (!value) {
      ok = false;
      break;
    }
    if (fgetxattr(fd, ordered[i], value, (size_t)size, 0, 0) != size)
      ok = false;
    else {
      CC_SHA256_Update(&context, ordered[i], (CC_LONG)strlen(ordered[i]) + 1);
      uint64_t bytes = (uint64_t)size;
      CC_SHA256_Update(&context, &bytes, sizeof(bytes));
      CC_SHA256_Update(&context, value, (CC_LONG)size);
    }
    free(value);
  }
  free(names);
  free(ordered);
  errno = 0;
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (acl) {
    ssize_t size = acl_size(acl);
    void *data =
        size >= 0 && size <= MAX_XATTR_BYTES ? malloc((size_t)size + 1) : NULL;
    if (!data || acl_copy_ext(data, acl, size) != size)
      ok = false;
    else
      CC_SHA256_Update(&context, data, (CC_LONG)size);
    free(data);
    acl_free(acl);
  } else if (errno != ENOENT && errno != 0)
    ok = false;
  CC_SHA256_Final(digest, &context);
  return ok;
}

static bool metadata(int fd, Metadata *out) {
  struct stat st;
  struct {
    uint32_t length;
    struct timespec time;
  } __attribute__((packed)) backup;
  struct attrlist attrs = {.bitmapcount = ATTR_BIT_MAP_COUNT,
                           .commonattr = ATTR_CMN_BKUPTIME};
  if (fstat(fd, &st) || fgetattrlist(fd, &attrs, &backup, sizeof(backup), 0))
    return false;
  *out = (Metadata){.dev = (uint64_t)st.st_dev,
                    .ino = st.st_ino,
                    .size = (uint64_t)st.st_size,
                    .uid = st.st_uid,
                    .gid = st.st_gid,
                    .mode = st.st_mode,
                    .flags = st.st_flags,
                    .birth_sec = st.st_birthtimespec.tv_sec,
                    .birth_nsec = st.st_birthtimespec.tv_nsec,
                    .mtime_sec = st.st_mtimespec.tv_sec,
                    .mtime_nsec = st.st_mtimespec.tv_nsec,
                    .atime_sec = st.st_atimespec.tv_sec,
                    .atime_nsec = st.st_atimespec.tv_nsec,
                    .backup_sec = backup.time.tv_sec,
                    .backup_nsec = backup.time.tv_nsec};
  return attribute_digest(fd, out->attributes);
}

static bool same_metadata(const Metadata *a, const Metadata *b) {
  return a->size == b->size && a->uid == b->uid && a->gid == b->gid &&
         a->mode == b->mode && a->flags == b->flags &&
         a->birth_sec == b->birth_sec && a->birth_nsec == b->birth_nsec &&
         a->mtime_sec == b->mtime_sec && a->mtime_nsec == b->mtime_nsec &&
         a->backup_sec == b->backup_sec && a->backup_nsec == b->backup_nsec &&
         !memcmp(a->attributes, b->attributes, CC_SHA256_DIGEST_LENGTH);
}

static bool restore_times(int fd, const Metadata *value) {
  struct attrlist attrs = {.bitmapcount = ATTR_BIT_MAP_COUNT,
                           .commonattr = ATTR_CMN_CRTIME | ATTR_CMN_MODTIME |
                                         ATTR_CMN_ACCTIME | ATTR_CMN_BKUPTIME};
  struct timespec times[] = {{value->birth_sec, value->birth_nsec},
                             {value->mtime_sec, value->mtime_nsec},
                             {value->atime_sec, value->atime_nsec},
                             {value->backup_sec, value->backup_nsec}};
  return fsetattrlist(fd, &attrs, times, sizeof(times), 0) == 0;
}

static void restore_access(int fd, const Metadata *value) {
  struct timespec times[] = {{value->atime_sec, value->atime_nsec},
                             {0, UTIME_OMIT}};
  if (fd >= 0)
    (void)futimens(fd, times);
}

static bool extended_number(int fd, attrgroup_t field, uint64_t *value) {
  struct attrlist attrs = {.bitmapcount = ATTR_BIT_MAP_COUNT,
                           .forkattr = field};
  struct {
    uint32_t length;
    uint64_t value;
  } __attribute__((packed)) result;
  if (fgetattrlist(fd, &attrs, &result, sizeof(result),
                   FSOPT_ATTR_CMN_EXTENDED) ||
      result.length != sizeof(result))
    return false;
  *value = result.value;
  return true;
}

static bool pristine(int fd, const Journal *journal, bool original) {
  struct stat st;
  Metadata current;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  return !fstat(fd, &st) && st.st_nlink == 1 && metadata(fd, &current) &&
         current.dev == journal->original.dev &&
         current.ino ==
             (original ? journal->original.ino : journal->clone_ino) &&
         same_metadata(&current, &journal->original) && sha_file(fd, digest) &&
         !memcmp(digest, journal->contents, sizeof(digest));
}

static int sync_fd(int fd) {
  int result;
  do
    result = fsync(fd);
  while (result < 0 && errno == EINTR);
  return result;
}

static bool write_all(int fd, const void *data, size_t size) {
  const char *bytes = data;
  while (size) {
    ssize_t count = write(fd, bytes, size);
    if (count < 0) {
      if (errno == EINTR)
        continue;
      return false;
    }
    if (!count)
      return false;
    bytes += count;
    size -= (size_t)count;
  }
  return true;
}

static bool store_journal(Pending *item) {
  int fd = openat(item->directory, "record.new",
                  O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0)
    return false;
  bool ok =
      write_all(fd, &item->journal, sizeof(item->journal)) && sync_fd(fd) == 0;
  close(fd);
  return ok &&
         renameat(item->directory, "record.new", item->directory, "record") ==
             0 &&
         sync_fd(item->directory) == 0;
}

static bool cleanup_pending(int stage, Pending *item) {
  if (unlinkat(item->directory, "record", 0) && errno != ENOENT)
    return false;
  if (unlinkat(item->directory, "record.new", 0) && errno != ENOENT)
    return false;
  if (sync_fd(item->directory))
    return false;
  if (unlinkat(stage, item->name, AT_REMOVEDIR))
    return false;
  return sync_fd(stage) == 0;
}

static void close_pending(Pending *item) {
  if (item->original >= 0)
    close(item->original);
  if (item->clone >= 0)
    close(item->clone);
  if (item->parent >= 0)
    close(item->parent);
  if (item->directory >= 0)
    close(item->directory);
  *item = (Pending){.parent = -1, .directory = -1, .original = -1, .clone = -1};
}

static bool target_identity(Pending *item, bool clone) {
  struct stat current, parent;
  return item->parent >= 0 && !fstat(item->parent, &parent) &&
         same_inode(&parent, item->journal.parent_dev,
                    item->journal.parent_ino) &&
         !fstatat(item->parent, item->basename, &current,
                  AT_SYMLINK_NOFOLLOW) &&
         same_inode(&current, item->journal.original.dev,
                    clone ? item->journal.clone_ino
                          : item->journal.original.ino) &&
         current.st_nlink == 1;
}

static bool quiesce_staged(Pending *item, int *descriptor) {
  if (linkat(item->directory, "file", item->directory, "witness", 0))
    return false;
  WORKTREE_SHARE_PHASE("after-witness");
  close(*descriptor);
  *descriptor = -1;
  bool quiet = unlinkat(item->directory, "witness", AT_NODELETEBUSY) == 0;
  if (!quiet)
    diagnose(descriptor == &item->original
                 ? "The kernel reports the original is still in use."
                 : "The kernel reports the replacement is still in use.");
  if (!quiet && unlinkat(item->directory, "witness", 0))
    return false;
  WORKTREE_SHARE_PHASE("after-quiesce");
  *descriptor =
      openat(item->directory, "file", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  return quiet && *descriptor >= 0;
}

static bool undo_pending(int stage, Pending *item) {
  if (item->exchanged) {
    if (!target_identity(item, true) ||
        !pristine(item->clone, &item->journal, false))
      return false;
    if (renameatx_np(item->directory, "file", item->parent, item->basename,
                     RENAME_SWAP))
      return false;
    item->exchanged = false;
    WORKTREE_SHARE_PHASE("after-rollback");
    if (sync_fd(item->directory) || sync_fd(item->parent))
      return false;
  }
  if (!target_identity(item, false))
    return false;
  if (!quiesce_staged(item, &item->clone))
    return false;
  if (!pristine(item->clone, &item->journal, false))
    return false;
  restore_access(item->original, &item->journal.original);
  close(item->clone);
  item->clone = -1;
  if (unlinkat(item->directory, "file", AT_NODELETEBUSY) && errno != ENOENT)
    return false;
  return cleanup_pending(stage, item);
}

static bool settle(int stage, Pending *items, size_t count, Totals *totals) {
  bool ok = true;
  for (size_t i = 0; i < count; i++) {
    Pending *item = items + i;
    uint64_t old_private = 0, new_private = 0;
    WORKTREE_SHARE_PHASE("before-settle");
    bool release =
        target_identity(item, true) && quiesce_staged(item, &item->original) &&
        pristine(item->original, &item->journal, true) &&
        pristine(item->clone, &item->journal, false) &&
        extended_number(item->original, ATTR_CMNEXT_PRIVATESIZE,
                        &old_private) &&
        extended_number(item->clone, ATTR_CMNEXT_PRIVATESIZE, &new_private);
    if (release) {
      restore_access(item->clone, &item->journal.original);
      if (sync_fd(item->clone))
        release = false;
      else {
        close(item->original);
        item->original = -1;
        if (unlinkat(item->directory, "file", AT_NODELETEBUSY)) {
          item->original = openat(item->directory, "file",
                                  O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
          release = false;
        }
      }
    }
    if (release) {
      WORKTREE_SHARE_PHASE("after-release");
      totals->shared++;
      if (old_private > new_private)
        totals->released += old_private - new_private;
      if (!cleanup_pending(stage, item))
        ok = false;
    } else {
      totals->skipped++;
      if (item->original < 0 || !undo_pending(stage, item)) {
        diagnose("An exchange changed or remains in use; both versions were "
                 "retained for recovery.");
        ok = false;
      }
    }
    close_pending(item);
  }
  return ok;
}

static int prepare(int stage, const struct stat *stage_stat, const char *source,
                   const char *target, Pending *item) {
  *item = (Pending){.parent = -1, .directory = -1, .original = -1, .clone = -1};
  int donor = -1;
  int result = 0;
  bool has_file = false;
  Metadata donor_metadata;
  struct stat st, source_st, parent_st;
  item->parent = open_parent(target, item->basename);
  if (item->parent < 0)
    goto done;
  item->original =
      openat(item->parent, item->basename, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (item->original < 0 || fstat(item->original, &st) || !owned_regular(&st) ||
      st.st_dev != stage_stat->st_dev ||
      flock(item->original, LOCK_EX | LOCK_NB))
    goto done;
  donor = open(source, O_RDONLY | O_NONBLOCK | O_NOFOLLOW_ANY | O_CLOEXEC);
  if (donor < 0 || fstat(donor, &source_st) || !owned_regular(&source_st) ||
      source_st.st_dev != st.st_dev || source_st.st_ino == st.st_ino ||
      source_st.st_size != st.st_size || !st.st_size)
    goto done;
  uint64_t donor_stream, target_stream;
  if (!extended_number(donor, ATTR_CMNEXT_CLONEID, &donor_stream) ||
      !extended_number(item->original, ATTR_CMNEXT_CLONEID, &target_stream)) {
    result = -1;
    goto done;
  }
  if (donor_stream && donor_stream == target_stream)
    goto done;
  if (!metadata(item->original, &item->journal.original) ||
      !metadata(donor, &donor_metadata) ||
      !sha_file(item->original, item->journal.contents) ||
      fstat(item->parent, &parent_st))
    goto done;
  item->journal.magic = JOURNAL_MAGIC;
  item->journal.parent_dev = (uint64_t)parent_st.st_dev;
  item->journal.parent_ino = parent_st.st_ino;
  strcpy(item->journal.target, target);
  for (unsigned attempt = 0; attempt < 16; attempt++) {
    snprintf(item->name, sizeof(item->name), "pair-%016" PRIx64 "%016" PRIx64,
             ((uint64_t)arc4random() << 32) | arc4random(),
             ((uint64_t)arc4random() << 32) | arc4random());
    if (!mkdirat(stage, item->name, 0700))
      break;
    if (errno != EEXIST || attempt == 15) {
      result = -1;
      goto done;
    }
  }
  item->directory = openat(stage, item->name,
                           O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (item->directory < 0 || !store_journal(item) || sync_fd(stage)) {
    result = -1;
    goto done;
  }
  if (fclonefileat(donor, item->directory, "file", 0)) {
    char detail[100];
    snprintf(detail, sizeof(detail), "Native clone failed (errno %d).", errno);
    diagnose(detail);
    result = -1;
    goto done;
  }
  has_file = true;
  item->clone =
      openat(item->directory, "file", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (item->clone < 0 || flock(item->clone, LOCK_EX | LOCK_NB))
    goto done;
  struct stat cloned;
  if (fstat(item->clone, &cloned))
    goto done;
  item->journal.clone_ino = cloned.st_ino;
  unsigned char cloned_digest[CC_SHA256_DIGEST_LENGTH];
  if (!sha_file(item->clone, cloned_digest) ||
      memcmp(cloned_digest, item->journal.contents, sizeof(cloned_digest)))
    goto done;
  if (fcopyfile(item->original, item->clone, NULL, COPYFILE_METADATA) ||
      !restore_times(item->clone, &item->journal.original) ||
      !pristine(item->original, &item->journal, true) ||
      !pristine(item->clone, &item->journal, false) || !store_journal(item) ||
      sync_fd(item->clone))
    goto done;
  WORKTREE_SHARE_PHASE("before-swap");
  if (stopped || !target_identity(item, false))
    goto done;
  if (renameatx_np(item->directory, "file", item->parent, item->basename,
                   RENAME_SWAP))
    goto done;
  item->exchanged = true;
  WORKTREE_SHARE_PHASE("after-swap");
  if (sync_fd(item->directory) || sync_fd(item->parent)) {
    result = -1;
    goto done;
  }
  result = 1;
done:
  if (donor >= 0) {
    if (item->journal.magic == JOURNAL_MAGIC)
      restore_access(donor, &donor_metadata);
    close(donor);
  }
  if (result != 1) {
    if (item->exchanged) {
      if (!undo_pending(stage, item))
        result = -1;
    } else if (item->directory >= 0) {
      if ((has_file && unlinkat(item->directory, "file", 0)) ||
          !cleanup_pending(stage, item))
        result = -1;
    }
    if (item->journal.magic == JOURNAL_MAGIC)
      restore_access(item->original, &item->journal.original);
    close_pending(item);
  }
  return result;
}

static bool recover(int stage) {
  int descriptor = dup(stage);
  if (descriptor < 0)
    return false;
  DIR *entries = fdopendir(descriptor);
  if (!entries) {
    close(descriptor);
    return false;
  }
  bool ok = true;
  struct dirent *entry;
  while ((entry = readdir(entries))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..") ||
        !strcmp(entry->d_name, ".lock"))
      continue;
    if (strncmp(entry->d_name, "pair-", 5) || strlen(entry->d_name) >= 80) {
      ok = false;
      continue;
    }
    Pending item = {.parent = -1, .directory = -1, .original = -1, .clone = -1};
    strcpy(item.name, entry->d_name);
    item.directory = openat(stage, entry->d_name,
                            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat directory_st;
    int record = item.directory < 0 ? -1
                                    : openat(item.directory, "record",
                                             O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    struct stat record_st;
    if (item.directory < 0 || fstat(item.directory, &directory_st) ||
        directory_st.st_uid != geteuid() || (directory_st.st_mode & 077) ||
        record < 0 || fstat(record, &record_st) || !owned_regular(&record_st) ||
        record_st.st_size != sizeof(Journal) ||
        pread(record, &item.journal, sizeof(Journal), 0) != sizeof(Journal) ||
        item.journal.magic != JOURNAL_MAGIC ||
        !memchr(item.journal.target, 0, PATH_MAX) ||
        !valid_path(item.journal.target)) {
      if (record >= 0)
        close(record);
      close_pending(&item);
      ok = false;
      continue;
    }
    close(record);
    item.parent = open_parent(item.journal.target, item.basename);
    struct stat target_st, file_st;
    int file =
        openat(item.directory, "file", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    int file_error = file < 0 ? errno : 0;
    if (item.parent < 0 ||
        fstatat(item.parent, item.basename, &target_st, AT_SYMLINK_NOFOLLOW)) {
      if (file >= 0)
        close(file);
      close_pending(&item);
      ok = false;
      continue;
    }
    struct stat witness_st;
    if (!fstatat(item.directory, "witness", &witness_st, AT_SYMLINK_NOFOLLOW)) {
      if (file < 0 || fstat(file, &file_st) ||
          witness_st.st_dev != file_st.st_dev ||
          witness_st.st_ino != file_st.st_ino || witness_st.st_nlink != 2 ||
          unlinkat(item.directory, "witness", 0)) {
        if (file >= 0)
          close(file);
        close_pending(&item);
        ok = false;
        continue;
      }
    } else if (errno != ENOENT) {
      if (file >= 0)
        close(file);
      close_pending(&item);
      ok = false;
      continue;
    }
    if (file < 0 && file_error == ENOENT) {
      if (!same_inode(&target_st, item.journal.original.dev,
                      item.journal.original.ino) &&
          !same_inode(&target_st, item.journal.original.dev,
                      item.journal.clone_ino))
        ok = false;
      else if (!cleanup_pending(stage, &item))
        ok = false;
    } else if (file >= 0 && !fstat(file, &file_st)) {
      int target_fd =
          openat(item.parent, item.basename, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
      if (same_inode(&target_st, item.journal.original.dev,
                     item.journal.original.ino)) {
        item.original = target_fd;
        item.clone = file;
      } else if (same_inode(&target_st, item.journal.original.dev,
                            item.journal.clone_ino) &&
                 same_inode(&file_st, item.journal.original.dev,
                            item.journal.original.ino)) {
        item.original = file;
        item.clone = target_fd;
        item.exchanged = true;
      } else {
        close(file);
        if (target_fd >= 0)
          close(target_fd);
        ok = false;
      }
      if (item.original >= 0 && item.clone >= 0) {
        if (flock(item.original, LOCK_EX | LOCK_NB) ||
            flock(item.clone, LOCK_EX | LOCK_NB) || !undo_pending(stage, &item))
          ok = false;
      }
    } else {
      if (file >= 0)
        close(file);
      ok = false;
    }
    close_pending(&item);
  }
  closedir(entries);
  if (!ok)
    diagnose("Staging contains unresolved recovery state; no new files will be "
             "changed.");
  return ok;
}

static bool kernel_guard(int stage) {
  char name[80], witness[90];
  snprintf(name, sizeof(name), "guard-%016" PRIx64,
           ((uint64_t)arc4random() << 32) | arc4random());
  int fd = openat(stage, name,
                  O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0)
    return false;
  snprintf(witness, sizeof(witness), "%s-witness", name);
  bool ok =
      ftruncate(fd, 4096) == 0 && linkat(stage, name, stage, witness, 0) == 0;
  if (ok) {
    errno = 0;
    ok = unlinkat(stage, witness, AT_NODELETEBUSY) == -1 && errno == EBUSY;
  }
  void *mapping =
      ok ? mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
         : MAP_FAILED;
  close(fd);
  if (mapping == MAP_FAILED)
    ok = false;
  if (ok) {
    errno = 0;
    ok = unlinkat(stage, witness, AT_NODELETEBUSY) == -1 && errno == EBUSY;
  }
  if (mapping != MAP_FAILED)
    munmap(mapping, 4096);
  if (ok)
    ok = unlinkat(stage, witness, AT_NODELETEBUSY) == 0;
  else
    (void)unlinkat(stage, witness, 0);
  if (unlinkat(stage, name, AT_NODELETEBUSY)) {
    (void)unlinkat(stage, name, 0);
    ok = false;
  }
  return ok;
}

static int read_path(char path[PATH_MAX]) {
  size_t used = 0;
  for (;;) {
    errno = 0;
    int byte = fgetc(stdin);
    if (byte == EOF) {
      if (stopped && errno == EINTR)
        return 0;
      return !used && feof(stdin) ? 0 : -1;
    }
    if (!byte) {
      path[used] = 0;
      return valid_path(path) ? 1 : -1;
    }
    if (used == PATH_MAX - 1)
      return -1;
    path[used++] = (char)byte;
  }
}

int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "--probe") && valid_path(argv[2])) {
    if (!__builtin_available(macOS 15.0, *))
      return 2;
    int directory =
        open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC);
    if (directory < 0)
      return 1;
    struct statfs volume;
    int result = fstatfs(directory, &volume);
    close(directory);
    return result ? 1 : strcmp(volume.f_fstypename, "apfs") ? 2 : 0;
  }
  if (argc != 2 || !valid_path(argv[1])) {
    diagnose("Expected one absolute private staging directory.");
    return 1;
  }
  struct sigaction action = {.sa_handler = stop_signal};
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  signal(SIGPIPE, SIG_IGN);
  if (!__builtin_available(macOS 15.0, *)) {
    diagnose("APFS sharing requires macOS 15 or later.");
    return 2;
  }
  int stage =
      open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC);
  struct stat stage_stat;
  struct statfs filesystem;
  if (stage < 0 || fstat(stage, &stage_stat) ||
      stage_stat.st_uid != geteuid() || (stage_stat.st_mode & 077) ||
      fstatfs(stage, &filesystem)) {
    diagnose("Staging must be a same-user private directory on APFS.");
    if (stage >= 0)
      close(stage);
    return 1;
  }
  if (strcmp(filesystem.f_fstypename, "apfs")) {
    close(stage);
    return 2;
  }
  int lock =
      openat(stage, ".lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  struct stat lock_stat;
  if (lock < 0 || fstat(lock, &lock_stat) || !owned_regular(&lock_stat) ||
      flock(lock, LOCK_EX | LOCK_NB)) {
    diagnose("Staging is already in use or its lock is unsafe.");
    if (lock >= 0)
      close(lock);
    close(stage);
    return 1;
  }
  Totals totals = {0};
  if (!kernel_guard(stage)) {
    diagnose("The kernel cannot protect open or mapped files from removal; "
             "sharing is unavailable.");
    close(lock);
    close(stage);
    return 2;
  }
  bool ok = recover(stage);
  Pending pending[BATCH_SIZE];
  size_t count = 0;
  char source[PATH_MAX], target[PATH_MAX];
  while (ok && !stopped) {
    int first = read_path(source);
    if (!first)
      break;
    if (first < 0 || read_path(target) != 1) {
      ok = stopped != 0;
      break;
    }
    int result = prepare(stage, &stage_stat, source, target, pending + count);
    if (result == 1)
      count++;
    else {
      totals.skipped++;
      if (result < 0)
        ok = false;
    }
    if (count == BATCH_SIZE) {
      if (!settle(stage, pending, count, &totals))
        ok = false;
      count = 0;
    }
  }
  if (count && !settle(stage, pending, count, &totals))
    ok = false;
  if (!ok)
    diagnose("Sharing stopped with an input, capability, or recovery error.");
  printf("{\"sharedFiles\":%" PRIu64 ",\"privateBytesReleased\":%" PRIu64
         ",\"skippedFiles\":%" PRIu64 "}\n",
         totals.shared, totals.released, totals.skipped);
  close(lock);
  close(stage);
  return ok ? 0 : 1;
}
