#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

static unsigned long long to_microseconds(uint64_t ticks, mach_timebase_info_data_t timebase) {
  return (unsigned long long)((long double)ticks * timebase.numer / timebase.denom / 1000);
}

int main(void) {
  const pid_t coordinator = getppid();
  mach_timebase_info_data_t timebase;
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0)
    return 1;

  const struct timespec interval = { .tv_nsec = 250000000 };

  while (coordinator > 1 && getppid() == coordinator) {
    struct rusage_info_v4 usage = {0};
    if (proc_pid_rusage(coordinator, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0)
      return 1;

    const unsigned long long at = clock_gettime_nsec_np(CLOCK_REALTIME) / 1000000;
    if (printf("%llu %llu %llu %llu %llu %llu\n", at,
        to_microseconds(usage.ri_runnable_time, timebase),
        to_microseconds(usage.ri_user_time + usage.ri_system_time, timebase),
        usage.ri_diskio_bytesread, usage.ri_diskio_byteswritten, usage.ri_pageins) < 0 ||
        fflush(stdout) != 0)
      return 1;

    nanosleep(&interval, NULL);
  }

  return 0;
}
