#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <CommonCrypto/CommonDigest.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <spawn.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static NSString *const team = @"Z7T4C33A35";
static BOOL exactRead(int fd, void *bytes, size_t length) {
  unsigned char *next = bytes;
  while (length) { ssize_t count = read(fd, next, length); if (count <= 0) return NO; next += count; length -= count; }
  return YES;
}
static BOOL exactWrite(int fd, const void *bytes, size_t length) {
  const unsigned char *next = bytes;
  while (length) { ssize_t count = write(fd, next, length); if (count <= 0) return NO; next += count; length -= count; }
  return YES;
}
static NSNumber *jsonBoolean(BOOL value) { return value ? @YES : @NO; }
static NSString *hex(NSData *data) {
  NSMutableString *result = [NSMutableString string];
  for (NSUInteger n=0; n<data.length; n++) [result appendFormat:@"%02x", ((const unsigned char *)data.bytes)[n]];
  return result;
}
static NSString *sha(NSData *data) {
  unsigned char value[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes,(CC_LONG)data.length,value);
  return hex([NSData dataWithBytes:value length:sizeof(value)]);
}
static BOOL digest(id value) {
  return [value isKindOfClass:NSString.class] && [(NSString *)value length]==64 &&
    [(NSString *)value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"abcdef0123456789"] invertedSet]].location==NSNotFound;
}
static BOOL ordinary(NSString *path, BOOL directory) {
  struct stat info;
  char resolved[PATH_MAX];
  return path.isAbsolutePath && realpath(path.fileSystemRepresentation,resolved) &&
    [path isEqualToString:[NSString stringWithUTF8String:resolved]] &&
    !lstat(path.fileSystemRepresentation,&info) && info.st_uid==getuid() &&
    (directory ? S_ISDIR(info.st_mode) : S_ISREG(info.st_mode)) &&
    (info.st_mode & 0022)==0;
}
static NSDictionary *signing(SecCodeRef code) {
  CFDictionaryRef data=NULL;
  if (SecCodeCheckValidity(code,kSecCSStrictValidate,NULL) || SecCodeCopySigningInformation(code,kSecCSSigningInformation,&data)) return nil;
  return CFBridgingRelease(data);
}
static BOOL matchesCode(SecCodeRef code, NSDictionary *expected, NSString *identifier, NSString *path) {
  NSDictionary *info=signing(code);
  if (!info || ![info[(__bridge NSString *)kSecCodeInfoTeamIdentifier] isEqual:team] ||
      ![info[(__bridge NSString *)kSecCodeInfoIdentifier] isEqual:identifier] ||
      ![hex(info[(__bridge NSString *)kSecCodeInfoUnique]) isEqual:expected[@"codeDirectoryHash"]]) return NO;
  NSURL *executable=info[(__bridge NSString *)kSecCodeInfoMainExecutable];
  if (![executable.path isEqual:path] || !ordinary(path,NO)) return NO;
  NSData *bytes=[NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:NULL];
  if (!bytes || ![sha(bytes) isEqual:expected[@"sha256"]]) return NO;
  if (![expected[@"designatedRequirement"] isKindOfClass:NSString.class]) return NO;
  SecRequirementRef requirement=NULL;
  OSStatus result=SecRequirementCreateWithString((__bridge CFStringRef)expected[@"designatedRequirement"],kSecCSDefaultFlags,&requirement);
  if (!result) result=SecCodeCheckValidity(code,kSecCSStrictValidate,requirement);
  if (requirement) CFRelease(requirement);
  return result==errSecSuccess;
}
static BOOL exactKeys(NSDictionary *value, NSArray *keys) {
  return [value isKindOfClass:NSDictionary.class] && [[NSSet setWithArray:value.allKeys] isEqual:[NSSet setWithArray:keys]];
}
static BOOL sourceDecimalString(id value) {
  if (![value isKindOfClass:NSString.class] || ![(NSString *)value length] || [(NSString *)value length]>20) return NO;
  const char *bytes=[value UTF8String];
  if (bytes[0]=='0' && bytes[1]) return NO;
  for (const char *next=bytes; *next; next++) if (*next<'0' || *next>'9') return NO;
  return YES;
}
static BOOL selectedSource(NSDictionary *selection, NSString *job) {
  id source=selection[@"sourceApplication"];
#ifdef OMNYO_TRANSFER_FIXTURE
  NSString *root=job.stringByDeletingLastPathComponent;
  NSString *oldName=@"BB Private";
  if (![root.lastPathComponent hasPrefix:@"test-"] ||
      (![root.lastPathComponent hasSuffix:@"--native-protected-store"] && ![root.lastPathComponent hasSuffix:@"--sealed-profile-v2"])) return NO;
  if (source==NSNull.null) return YES;
  NSArray *paths=@[[root stringByAppendingPathComponent:@"Source.app"]];
#else
  NSString *oldName=selection[@"oldStorageName"];
  NSArray *paths=[oldName isEqual:@"BB Private"] ? @[@"/Applications/BB Private VPS.app",@"/Applications/BB Private.app"] : @[@"/Applications/BB Private Nightly.app"];
#endif
  if (!exactKeys(source,@[@"appPath",@"profilePath",@"executable",@"originalMode",@"device",@"inode"])) return NO;
  NSDictionary *executable=source[@"executable"];
  id mode=source[@"originalMode"];
  if (!exactKeys(executable,@[@"path",@"sha256",@"codeDirectoryHash",@"designatedRequirement"]) ||
      ![paths containsObject:source[@"appPath"]] || ![source[@"profilePath"] isKindOfClass:NSString.class] ||
      ![source[@"profilePath"] isAbsolutePath] || ![[source[@"profilePath"] lastPathComponent] isEqual:oldName] ||
      ![executable[@"path"] isEqual:[[source[@"appPath"] stringByAppendingPathComponent:@"Contents/MacOS"] stringByAppendingPathComponent:oldName]] ||
      !digest(executable[@"sha256"]) || ![executable[@"codeDirectoryHash"] isKindOfClass:NSString.class] || [executable[@"codeDirectoryHash"] length]!=40 ||
      ![executable[@"designatedRequirement"] isKindOfClass:NSString.class] || ![executable[@"designatedRequirement"] length] || [executable[@"designatedRequirement"] length]>8192 ||
      ![mode isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)mode)==CFBooleanGetTypeID() ||
      [mode doubleValue]!=[mode integerValue] || [mode integerValue]<0 || [mode integerValue]>0777 ||
      ([mode integerValue]&0111)==0 || ([mode integerValue]&0022)!=0 || !sourceDecimalString(source[@"device"]) || !sourceDecimalString(source[@"inode"])) return NO;
#ifdef OMNYO_TRANSFER_FIXTURE
  if (![source[@"profilePath"] isEqual:[root stringByAppendingPathComponent:@"profiles/BB Private"]]) return NO;
#endif
  return YES;
}
static BOOL sourceFileState(int fd, NSDictionary *source, mode_t *mode) {
  struct stat info, named;
  NSString *path=source[@"executable"][@"path"];
  mode_t original=[source[@"originalMode"] unsignedShortValue];
  if (fstat(fd,&info) || lstat(path.fileSystemRepresentation,&named) || !S_ISREG(info.st_mode) || !S_ISREG(named.st_mode) ||
      info.st_dev!=named.st_dev || info.st_ino!=named.st_ino || info.st_uid!=getuid() || info.st_nlink!=1 ||
      ![[NSString stringWithFormat:@"%llu",(unsigned long long)info.st_dev] isEqual:source[@"device"]] ||
      ![[NSString stringWithFormat:@"%llu",(unsigned long long)info.st_ino] isEqual:source[@"inode"]] ||
      ((info.st_mode&07777)!=original && (info.st_mode&07777)!=(original&~0111))) return NO;
  *mode=info.st_mode&0777;
  return YES;
}
static BOOL sourceBytes(int fd, NSDictionary *source) {
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  unsigned char bytes[65536], value[CC_SHA256_DIGEST_LENGTH];
  off_t offset=0;
  for (;;) {
    ssize_t count=pread(fd,bytes,sizeof(bytes),offset);
    if (count<0) return NO;
    if (!count) break;
    offset+=count;
    if (offset>512*1024*1024) return NO;
    CC_SHA256_Update(&context,bytes,(CC_LONG)count);
  }
  CC_SHA256_Final(value,&context);
  return [hex([NSData dataWithBytes:value length:sizeof(value)]) isEqual:source[@"executable"][@"sha256"]];
}
static int sourceDescriptor(NSDictionary *selection) {
  id source=selection[@"sourceApplication"];
#ifdef OMNYO_TRANSFER_FIXTURE
  if (source==NSNull.null) return -2;
#endif
  if (![source isKindOfClass:NSDictionary.class] || !ordinary(source[@"appPath"],YES) || !ordinary(source[@"profilePath"],YES) ||
      !ordinary(source[@"executable"][@"path"],NO)) return -1;
  NSString *path=source[@"executable"][@"path"];
  int fd=open(path.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
  if (fd<0) return -1;
  mode_t mode=0;
  if (!sourceFileState(fd,source,&mode) || !sourceBytes(fd,source)) { close(fd); return -1; }
  SecStaticCodeRef code=NULL;
  SecRequirementRef requirement=NULL;
  NSDictionary *expected=source[@"executable"];
  OSStatus status=SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:path],kSecCSDefaultFlags,&code);
  if (!status) status=SecRequirementCreateWithString((__bridge CFStringRef)expected[@"designatedRequirement"],kSecCSDefaultFlags,&requirement);
  if (!status) status=SecStaticCodeCheckValidity(code,kSecCSStrictValidate|kSecCSCheckAllArchitectures,requirement);
  CFDictionaryRef raw=NULL;
  if (!status) status=SecCodeCopySigningInformation(code,kSecCSSigningInformation,&raw);
  NSDictionary *info=raw ? CFBridgingRelease(raw) : nil;
  BOOL valid=!status && [info[(__bridge NSString *)kSecCodeInfoIdentifier] isEqual:@"dev.bb.private"] &&
    [info[(__bridge NSString *)kSecCodeInfoTeamIdentifier] isEqual:team] &&
    [hex(info[(__bridge NSString *)kSecCodeInfoUnique]) isEqual:expected[@"codeDirectoryHash"]] &&
    [[info[(__bridge NSString *)kSecCodeInfoMainExecutable] path] isEqual:path] && sourceFileState(fd,source,&mode) && sourceBytes(fd,source);
  if (requirement) CFRelease(requirement);
  if (code) CFRelease(code);
  if (!valid) { close(fd); return -1; }
  return fd;
}
static int sourceReport(NSString *operation, NSString *binding, mode_t mode) {
  NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"version":@2,@"operation":operation,@"bindingSha256":binding,
    @"outcome":[operation isEqual:@"fence-source"] ? @"fenced" : @"restored",@"sourceMode":@(mode),@"admitted":@NO,
    @"protectedStore":@YES,@"authenticationUIFail":@YES,@"interactionNotAllowed":@YES} options:0 error:NULL];
  return data && exactWrite(STDOUT_FILENO,data.bytes,data.length) ? 0 : 119;
}
static NSDictionary *loadSelection(NSString *job) {
  if (!ordinary(job,YES)) return nil;
  NSString *path=[job stringByAppendingPathComponent:@"Contents/Resources/selection.json"];
  if (!ordinary(path,NO)) return nil;
  NSData *before=[NSData dataWithContentsOfFile:path options:0 error:NULL];
  if (!before || before.length>16384) return nil;
  SecStaticCodeRef code=NULL;
  SecRequirementRef requirement=NULL;
  OSStatus result=SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:job],kSecCSDefaultFlags,&code);
  NSString *rule=@"anchor apple generic and identifier \"dev.omnyo.private.protected-store-job-v2\" and certificate leaf[subject.OU] = \"Z7T4C33A35\"";
  if (!result) result=SecRequirementCreateWithString((__bridge CFStringRef)rule,kSecCSDefaultFlags,&requirement);
  if (!result) result=SecStaticCodeCheckValidity(code,kSecCSStrictValidate|kSecCSCheckAllArchitectures,requirement);
  if (requirement) CFRelease(requirement);
  if (code) CFRelease(code);
  if (result || ![before isEqual:[NSData dataWithContentsOfFile:path options:0 error:NULL]]) return nil;
  NSDictionary *selection=[NSJSONSerialization JSONObjectWithData:before options:0 error:NULL];
  if (![selection isKindOfClass:NSDictionary.class] || ![selection[@"version"] isEqual:@2] ||
      !digest(selection[@"bindingSha256"]) || !digest(selection[@"profileBindingSha256"]) ||
      ![selection[@"keychainBackend"] isEqual:@"default-SecItem-macOS"] ||
      ![selection[@"admissionPath"] isKindOfClass:NSString.class] ||
      ![selection[@"reader"] isKindOfClass:NSDictionary.class] || ![selection[@"writer"] isKindOfClass:NSDictionary.class]) return nil;
  NSString *old=selection[@"oldStorageName"], *new=selection[@"newStorageName"];
#ifdef OMNYO_TRANSFER_FIXTURE
  if (![old isEqualToString:@OMNYO_TRANSFER_FIXTURE " Legacy"] || ![new isEqualToString:@OMNYO_TRANSFER_FIXTURE " Current"]) return nil;
#else
  BOOL stable=[old isEqualToString:@"BB Private"] && [new isEqualToString:@"Omnyo Private"];
  BOOL nightly=[old isEqualToString:@"BB Private Nightly"] && [new isEqualToString:@"Omnyo Private Nightly"];
  if (!stable && !nightly) return nil;
#endif
  if (!exactKeys(selection,@[@"version",@"keychainBackend",@"oldStorageName",@"newStorageName",@"profileBindingSha256",@"admissionPath",@"sourceApplication",@"reader",@"writer",@"bindingSha256"]) || !selectedSource(selection,job)) return nil;
  return selection;
}
static NSMutableDictionary *itemQuery(NSString *name) {
  LAContext *context=[[LAContext alloc] init];
  context.interactionNotAllowed=YES;
  return [@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService:[name stringByAppendingString:@" Safe Storage"],
    (__bridge id)kSecAttrAccount:[name stringByAppendingString:@" Key"],
    (__bridge id)kSecUseAuthenticationUI:(__bridge id)kSecUseAuthenticationUIFail,
    (__bridge id)kSecUseAuthenticationContext:context} mutableCopy];
}
static int report(NSString *operation, NSString *binding, NSString *outcome, BOOL created, BOOL admitted) {
  NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"version":@2,@"operation":operation,@"bindingSha256":binding,
    @"outcome":outcome,@"created":jsonBoolean(created),@"admitted":jsonBoolean(admitted),
    @"protectedStore":@YES,@"authenticationUIFail":@YES,@"interactionNotAllowed":@YES} options:0 error:NULL];
  return data && exactWrite(STDOUT_FILENO,data.bytes,data.length) ? 0 : 119;
}
static int latch(NSString *path, BOOL lock) {
  if (!ordinary(path,NO)) return -1;
  int fd=open(path.fileSystemRepresentation,(lock ? O_RDWR : O_RDONLY)|O_NOFOLLOW|O_CLOEXEC);
  struct stat info;
  if (fd<0) return -1;
  if (fstat(fd,&info) || info.st_uid!=getuid() || !S_ISREG(info.st_mode) || info.st_size!=1 ||
      (info.st_mode & 0077) || info.st_nlink!=1 || (lock && flock(fd,LOCK_EX|LOCK_NB))) { close(fd); return -1; }
  return fd;
}
static BOOL closeAdmission(int fd) { char value=0; return pread(fd,&value,1,0)==1 && value=='0'; }
static BOOL openAdmission(int fd) { char value='1'; return pwrite(fd,&value,1,0)==1 && fsync(fd)==0; }
static NSMutableData *readFromOwner(NSString *job, NSString *readerPath, BOOL badChannel) {
  int channel[2];
  if (pipe(channel)) return nil;
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  posix_spawn_file_actions_init(&actions);
  posix_spawnattr_init(&attributes);
  posix_spawnattr_setflags(&attributes,POSIX_SPAWN_CLOEXEC_DEFAULT);
  posix_spawn_file_actions_addopen(&actions,STDIN_FILENO,"/dev/null",O_RDONLY,0);
  posix_spawn_file_actions_addopen(&actions,STDOUT_FILENO,"/dev/null",O_WRONLY,0);
  posix_spawn_file_actions_addopen(&actions,STDERR_FILENO,"/dev/null",O_WRONLY,0);
  if (badChannel) posix_spawn_file_actions_addopen(&actions,3,"/dev/null",O_WRONLY,0);
  else posix_spawn_file_actions_adddup2(&actions,channel[1],3);
  char *const arguments[]={(char *)readerPath.fileSystemRepresentation,"read",(char *)job.fileSystemRepresentation,NULL};
  char *const environment[]={"PATH=/usr/bin:/bin",NULL};
  pid_t child=0;
  int status=posix_spawn(&child,readerPath.fileSystemRepresentation,&actions,&attributes,arguments,environment);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attributes);
  close(channel[1]);
  uint32_t encoded=0;
  NSMutableData *data=nil;
  if (!status && exactRead(channel[0],&encoded,sizeof(encoded))) {
    uint32_t length=ntohl(encoded);
    if (length && length<=4096) {
      data=[NSMutableData dataWithLength:length];
      unsigned char extra=0;
      if (!exactRead(channel[0],data.mutableBytes,length) || read(channel[0],&extra,1)!=0) {
        [data resetBytesInRange:NSMakeRange(0,data.length)]; data=nil;
      }
    }
  }
  close(channel[0]);
  int childStatus=0;
  if (status || waitpid(child,&childStatus,0)!=child || !WIFEXITED(childStatus) || WEXITSTATUS(childStatus)!=0) {
    [data resetBytesInRange:NSMakeRange(0,data.length)]; return nil;
  }
  return data;
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    alarm(4);
    if (argc!=3) return 90;
    OSStatus status=SecKeychainSetUserInteractionAllowed(false);
    Boolean allowed=true;
    if (status || SecKeychainGetUserInteractionAllowed(&allowed) || allowed) return 91;
    NSString *operation=[NSString stringWithUTF8String:argv[1]];
    SecCodeRef self=NULL;
    if (SecCodeCopySelf(kSecCSDefaultFlags,&self)) return 92;
    NSDictionary *selfInfo=signing(self);
    NSString *identifier=selfInfo[(__bridge NSString *)kSecCodeInfoIdentifier];
    BOOL reader=[identifier isEqualToString:@"dev.bb.private"];
    BOOL writer=[identifier isEqualToString:@"dev.omnyo.private"];
    if ((!reader && !writer) || ![selfInfo[(__bridge NSString *)kSecCodeInfoTeamIdentifier] isEqual:team]) { CFRelease(self); return 93; }
#ifdef OMNYO_TRANSFER_FIXTURE
    if ([operation isEqualToString:@"seed"] || [operation isEqualToString:@"inspect"] || [operation isEqualToString:@"inspect-legacy"] || [operation isEqualToString:@"cleanup"] || [operation isEqualToString:@"reference-status"]) {
      if (strcmp(argv[2],OMNYO_TRANSFER_FIXTURE)) { CFRelease(self); return 94; }
      NSString *name=reader ? @OMNYO_TRANSFER_FIXTURE " Legacy" : @OMNYO_TRANSFER_FIXTURE " Current";
      NSMutableDictionary *query=itemQuery(name);
      BOOL legacyInspection=[operation isEqualToString:@"inspect-legacy"];
      if (legacyInspection) query[(__bridge id)kSecAttrAccount]=name;
      CFRelease(self);
      if ([operation isEqualToString:@"seed"]) {
        if (!reader) return 95;
        NSMutableData *bytes=[NSMutableData dataWithLength:32];
        status=SecRandomCopyBytes(kSecRandomDefault,bytes.length,bytes.mutableBytes);
        if (!status) { query[(__bridge id)kSecValueData]=bytes; status=SecItemAdd((__bridge CFDictionaryRef)query,NULL); }
        [bytes resetBytesInRange:NSMakeRange(0,bytes.length)]; return status ? 96 : 0;
      }
      if ([operation isEqualToString:@"cleanup"] || [operation isEqualToString:@"reference-status"]) {
#if defined(OMNYO_FIXTURE_RECOVERY_CREATED_FROM_MS) && defined(OMNYO_FIXTURE_RECOVERY_CREATED_TO_MS)
        NSMutableDictionary *lookup=[query mutableCopy];
        lookup[(__bridge id)kSecReturnAttributes]=@YES;
        lookup[(__bridge id)kSecReturnPersistentRef]=@YES;
        lookup[(__bridge id)kSecMatchLimit]=(__bridge id)kSecMatchLimitAll;
        CFTypeRef raw=NULL;
        status=SecItemCopyMatching((__bridge CFDictionaryRef)lookup,&raw);
        NSArray *records=raw ? CFBridgingRelease(raw) : nil;
        if (status==errSecItemNotFound) return 0;
        if (status || ![records isKindOfClass:NSArray.class] || records.count!=1) return 125;
        NSDictionary *record=records[0];
        NSDate *created=record[(__bridge id)kSecAttrCreationDate];
        double createdMs=[created isKindOfClass:NSDate.class] ? created.timeIntervalSince1970*1000.0 : 0;
        NSData *reference=record[(__bridge id)kSecValuePersistentRef];
        if (createdMs<OMNYO_FIXTURE_RECOVERY_CREATED_FROM_MS || createdMs>OMNYO_FIXTURE_RECOVERY_CREATED_TO_MS ||
          ![reference isKindOfClass:NSData.class] || ![record[(__bridge id)kSecAttrService] isEqual:query[(__bridge id)kSecAttrService]] ||
          ![record[(__bridge id)kSecAttrAccount] isEqual:query[(__bridge id)kSecAttrAccount]]) return 126;
        NSMutableDictionary *selected=itemQuery(name);
        [selected removeObjectForKey:(__bridge id)kSecAttrService];
        [selected removeObjectForKey:(__bridge id)kSecAttrAccount];
        selected[(__bridge id)kSecMatchItemList]=@[reference];
        Boolean interactive=true;
        if (SecKeychainSetUserInteractionAllowed(false) || SecKeychainGetUserInteractionAllowed(&interactive) || interactive) return 127;
        if ([operation isEqualToString:@"reference-status"]) {
          selected[(__bridge id)kSecReturnAttributes]=@YES;
          CFTypeRef verified=NULL;
          status=SecItemCopyMatching((__bridge CFDictionaryRef)selected,&verified);
          id value=verified ? CFBridgingRelease(verified) : nil;
          NSDictionary *attributes=[value isKindOfClass:NSDictionary.class] ? value :
            ([value isKindOfClass:NSArray.class] && [value count]==1 && [value[0] isKindOfClass:NSDictionary.class] ? value[0] : nil);
          BOOL same=attributes && [attributes[(__bridge id)kSecAttrService] isEqual:record[(__bridge id)kSecAttrService]] &&
            [attributes[(__bridge id)kSecAttrAccount] isEqual:record[(__bridge id)kSecAttrAccount]] &&
            [attributes[(__bridge id)kSecAttrCreationDate] isEqual:record[(__bridge id)kSecAttrCreationDate]] &&
            [attributes[(__bridge id)kSecAttrModificationDate] isEqual:record[(__bridge id)kSecAttrModificationDate]];
          NSData *proof=[NSJSONSerialization dataWithJSONObject:@{@"referenceSelectorOsStatus":@((int)status),@"sameAttributes":jsonBoolean(same),@"interactionNotAllowed":@YES} options:0 error:NULL];
          if (!proof || !exactWrite(STDOUT_FILENO,proof.bytes,proof.length)) return 98;
          return status==errSecSuccess && same ? 0 : 129;
        }
        status=SecItemDelete((__bridge CFDictionaryRef)selected);
#else
        if ([operation isEqualToString:@"reference-status"]) return 128;
        status=SecItemDelete((__bridge CFDictionaryRef)query);
#endif
        NSData *proof=[NSJSONSerialization dataWithJSONObject:@{@"cleanupOsStatus":@((int)status),@"interactionNotAllowed":@YES} options:0 error:NULL];
        if (!proof || !exactWrite(STDOUT_FILENO,proof.bytes,proof.length)) return 98;
        return status==errSecSuccess || status==errSecItemNotFound ? 0 : 97;
      }
      query[(__bridge id)kSecReturnAttributes]=@YES;
      query[(__bridge id)kSecMatchLimit]=(__bridge id)kSecMatchLimitOne;
      CFTypeRef found=NULL;
      status=SecItemCopyMatching((__bridge CFDictionaryRef)query,&found);
      NSDictionary *attributes=found ? CFBridgingRelease(found) : nil;
      NSDate *created=attributes[(__bridge id)kSecAttrCreationDate];
      NSDate *modified=attributes[(__bridge id)kSecAttrModificationDate];
      BOOL expected=(!attributes || ([attributes[(__bridge id)kSecAttrService] isEqual:query[(__bridge id)kSecAttrService]] &&
        [attributes[(__bridge id)kSecAttrAccount] isEqual:query[(__bridge id)kSecAttrAccount]]));
      double createdMs=[created isKindOfClass:NSDate.class] ? created.timeIntervalSince1970*1000.0 : 0;
      double modifiedMs=[modified isKindOfClass:NSDate.class] ? modified.timeIntervalSince1970*1000.0 : 0;
      NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"accountKind":legacyInspection ? @"legacy-bare" : @"canonical-key",@"absent":jsonBoolean(status==errSecItemNotFound),@"present":jsonBoolean(status==errSecSuccess),@"osStatus":@((int)status),@"interactionNotAllowed":@YES,@"exactAttributes":jsonBoolean(expected),@"createdAtMs":@(createdMs),@"modifiedAtMs":@(modifiedMs)} options:0 error:NULL];
      if (!exactWrite(STDOUT_FILENO,data.bytes,data.length)) return 98;
      return status==errSecSuccess || status==errSecItemNotFound ? 0 : 99;
    }
#endif
    NSString *job=[NSString stringWithUTF8String:argv[2]];
    NSDictionary *selection=loadSelection(job);
    if (!selection) { CFRelease(self); return 100; }
    NSString *resources=[job stringByAppendingPathComponent:@"Contents/Resources"];
    NSString *readerPath=[resources stringByAppendingPathComponent:@"old-reader"];
    NSString *writerPath=[resources stringByAppendingPathComponent:@"new-writer"];
    if (!matchesCode(self,selection[reader ? @"reader" : @"writer"],identifier,reader ? readerPath : writerPath)) { CFRelease(self); return 101; }
    CFRelease(self);
    if (reader) {
      if (![operation isEqualToString:@"read"]) return 102;
      pid_t parent=getppid();
      SecCodeRef peer=NULL;
      NSDictionary *attributes=@{(__bridge NSString *)kSecGuestAttributePid:@(parent)};
      if (SecCodeCopyGuestWithAttributes(NULL,(__bridge CFDictionaryRef)attributes,kSecCSDefaultFlags,&peer)) return 103;
      BOOL trusted=matchesCode(peer,selection[@"writer"],@"dev.omnyo.private",writerPath);
      CFRelease(peer);
      struct stat channel;
      int flags=fcntl(3,F_GETFL);
      if (!trusted || parent!=getppid() || fstat(3,&channel) || !S_ISFIFO(channel.st_mode) || flags<0 || (flags&O_ACCMODE)!=O_WRONLY) return 104;
      int admission=latch(selection[@"admissionPath"],NO);
      if (admission<0 || !closeAdmission(admission)) { if (admission>=0) close(admission); return 105; }
      int source=sourceDescriptor(selection);
      mode_t sourceMode=0;
      if (source==-1 || (source>=0 && (!sourceFileState(source,selection[@"sourceApplication"],&sourceMode) || (sourceMode&0111)))) {
        if (source>=0) close(source);
        close(admission); return 122;
      }
      if (source>=0) close(source);
      close(admission);
      NSMutableDictionary *query=itemQuery(selection[@"oldStorageName"]);
      query[(__bridge id)kSecReturnData]=@YES;
      query[(__bridge id)kSecMatchLimit]=(__bridge id)kSecMatchLimitOne;
      CFTypeRef value=NULL;
      status=SecItemCopyMatching((__bridge CFDictionaryRef)query,&value);
      if (status || !value) return 106;
      NSMutableData *bytes=[(__bridge NSData *)value mutableCopy];
      CFRelease(value);
      if (!bytes.length || bytes.length>4096) return 107;
      uint32_t length=htonl((uint32_t)bytes.length);
      BOOL sent=parent==getppid() && exactWrite(3,&length,sizeof(length)) && exactWrite(3,bytes.bytes,bytes.length);
      [bytes resetBytesInRange:NSMakeRange(0,bytes.length)];
      return sent ? 0 : 108;
    }
    if (![@[@"write",@"rollback",@"admit",@"status",@"fence-source",@"restore-source"] containsObject:operation]
#ifdef OMNYO_TRANSFER_FIXTURE
        && ![operation isEqualToString:@"probe-channel"] && ![operation isEqualToString:@"admit-interrupt"]
#endif
       ) return 109;
    int admission=latch(selection[@"admissionPath"],YES);
    if (admission<0) return 110;
    BOOL closed=closeAdmission(admission);
    BOOL sourceOperation=[operation isEqual:@"fence-source"] || [operation isEqual:@"restore-source"];
    int source=sourceDescriptor(selection);
    mode_t sourceMode=0;
    if (source==-1 || (sourceOperation && source<0) || (source>=0 && !sourceFileState(source,selection[@"sourceApplication"],&sourceMode))) {
      if (source>=0) close(source);
      close(admission); return 122;
    }
    BOOL needsFence=[operation isEqual:@"write"] || [operation isEqual:@"admit"];
#ifdef OMNYO_TRANSFER_FIXTURE
    needsFence=needsFence || [operation isEqual:@"admit-interrupt"];
#endif
    if (source>=0 && needsFence && (sourceMode&0111)) { close(source); close(admission); return 123; }
    if (!sourceOperation && !needsFence && source>=0) { close(source); source=-2; }
    NSString *binding=selection[@"bindingSha256"];
    NSData *closedTag=[[NSString stringWithFormat:@"omnyo-protected-store-v2:%@:closed",binding] dataUsingEncoding:NSUTF8StringEncoding];
    NSData *admittedTag=[[NSString stringWithFormat:@"omnyo-protected-store-v2:%@:admitted",binding] dataUsingEncoding:NSUTF8StringEncoding];
    NSMutableDictionary *query=itemQuery(selection[@"newStorageName"]);
    NSMutableDictionary *lookup=[query mutableCopy];
    if (!sourceOperation) lookup[(__bridge id)kSecReturnData]=@YES;
    lookup[(__bridge id)kSecReturnAttributes]=@YES;
    lookup[(__bridge id)kSecMatchLimit]=(__bridge id)kSecMatchLimitOne;
    CFTypeRef result=NULL;
    status=SecItemCopyMatching((__bridge CFDictionaryRef)lookup,&result);
    NSDictionary *stored=result ? CFBridgingRelease(result) : nil;
    if (status!=errSecSuccess && status!=errSecItemNotFound) { if (source>=0) close(source); close(admission); return 111; }
    BOOL admitted=[stored[(__bridge id)kSecAttrGeneric] isEqual:admittedTag];
    BOOL owned=[stored[(__bridge id)kSecAttrGeneric] isEqual:closedTag] || admitted;
    if (stored && !owned) { if (source>=0) close(source); close(admission); return 112; }
    if (sourceOperation) {
      if (!closed || admitted || ([operation isEqual:@"restore-source"] && stored)) { close(source); close(admission); return 116; }
      mode_t selected=[selection[@"sourceApplication"][@"originalMode"] unsignedShortValue];
      if ([operation isEqual:@"fence-source"]) selected&=~0111;
      BOOL changed=sourceFileState(source,selection[@"sourceApplication"],&sourceMode) && sourceBytes(source,selection[@"sourceApplication"]) &&
        !fchmod(source,selected) && !fsync(source) && sourceFileState(source,selection[@"sourceApplication"],&sourceMode) &&
        sourceMode==selected && sourceBytes(source,selection[@"sourceApplication"]);
      close(source); close(admission);
      return changed ? sourceReport(operation,binding,selected) : 122;
    }
    if ([operation isEqualToString:@"status"]) {
      if (admitted && !closed) { close(admission); return report(operation,binding,@"admitted",NO,YES); }
      if (admitted && closed) { close(admission); return report(operation,binding,@"admitted-recovery-required",NO,YES); }
      if (!closed) { close(admission); return 113; }
      close(admission); return report(operation,binding,stored ? @"closed" : @"absent",NO,NO);
    }
    if ([operation isEqualToString:@"admit"]
#ifdef OMNYO_TRANSFER_FIXTURE
        || [operation isEqualToString:@"admit-interrupt"]
#endif
       ) {
      if (!stored || (!closed && !admitted)) { close(admission); return 114; }
      if (source>=0 && (!sourceFileState(source,selection[@"sourceApplication"],&sourceMode) || (sourceMode&0111) || !sourceBytes(source,selection[@"sourceApplication"]))) { close(source); close(admission); return 122; }
      if (source>=0) { close(source); source=-2; }
      if (!admitted) status=SecItemUpdate((__bridge CFDictionaryRef)query,(__bridge CFDictionaryRef)@{(__bridge id)kSecAttrGeneric:admittedTag});
#ifdef OMNYO_TRANSFER_FIXTURE
      if (!status && [operation isEqualToString:@"admit-interrupt"]) { close(admission); return 124; }
#endif
      if (status || !openAdmission(admission)) { close(admission); return 115; }
      close(admission); return report(operation,binding,@"admitted",NO,YES);
    }
    if (!closed || admitted) { close(admission); return 116; }
    if ([operation isEqualToString:@"rollback"]) {
      if (stored) status=SecItemDelete((__bridge CFDictionaryRef)query);
      close(admission);
      return status==errSecSuccess || status==errSecItemNotFound ? report(operation,binding,stored ? @"removed" : @"absent",NO,NO) : 117;
    }
#ifdef OMNYO_TRANSFER_FIXTURE
    if ([operation isEqualToString:@"probe-channel"]) {
      NSMutableData *bytes=readFromOwner(job,readerPath,YES);
      BOOL denied=bytes==nil;
      [bytes resetBytesInRange:NSMakeRange(0,bytes.length)];
      close(admission);
      return denied ? report(operation,binding,@"channel-denied",NO,NO) : 118;
    }
#endif
    NSMutableData *incoming=readFromOwner(job,readerPath,NO);
    if (!incoming) { close(admission); return 120; }
    if (source>=0 && (!sourceFileState(source,selection[@"sourceApplication"],&sourceMode) || (sourceMode&0111) || !sourceBytes(source,selection[@"sourceApplication"]))) {
      [incoming resetBytesInRange:NSMakeRange(0,incoming.length)]; close(source); close(admission); return 122;
    }
    if (source>=0) { close(source); source=-2; }
    BOOL created=NO;
    if (!stored) {
      query[(__bridge id)kSecValueData]=incoming;
      query[(__bridge id)kSecAttrGeneric]=closedTag;
      status=SecItemAdd((__bridge CFDictionaryRef)query,NULL);
      created=status==errSecSuccess;
    } else if (![stored[(__bridge id)kSecValueData] isEqual:incoming]) status=errSecDuplicateItem;
    [incoming resetBytesInRange:NSMakeRange(0,incoming.length)];
    close(admission);
    return status==errSecSuccess ? report(operation,binding,@"copied",created,NO) : 121;
  }
}

#ifdef OMNYO_FIXTURE_CLEANUP_NAPI
#if !defined(OMNYO_TRANSFER_FIXTURE) || !defined(OMNYO_FIXTURE_RECOVERY_CREATED_FROM_MS) || !defined(OMNYO_FIXTURE_RECOVERY_CREATED_TO_MS)
#error Fixture_cleanup_requires_exact_namespace_and_creation_binding
#endif
#include <node_api.h>
static napi_value cleanupSyntheticOwnedItemV1(napi_env env, napi_callback_info info) {
  const char *arguments[] = { "fixture-creator-cleanup", "cleanup", OMNYO_TRANSFER_FIXTURE };
  int status = main(3, arguments);
  napi_value result;
  if (napi_create_int32(env, status, &result) != napi_ok) return NULL;
  return result;
}
NAPI_MODULE_INIT() {
  napi_value function;
  if (napi_create_function(env, "cleanupSyntheticOwnedItemV1", NAPI_AUTO_LENGTH, cleanupSyntheticOwnedItemV1, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "cleanupSyntheticOwnedItemV1", function) != napi_ok) return NULL;
  return exports;
}
#endif
