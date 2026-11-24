#import "OmnyoPreferencesRecordsV1.h"
#import <MMKVCore/MMKV.h>

static std::string OmnyoPreferenceRootV1(NSString *identifier) {
  if (![@[@"bb.preferences", @"omnyo.preferences"] containsObject:identifier]) {
    @throw [NSException exceptionWithName:@"OmnyoPreferencesIdentity" reason:@"Unsupported preference store identity." userInfo:nil];
  }
  NSURL *documents = [NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
  std::string root = [[documents URLByAppendingPathComponent:@"mmkv" isDirectory:YES].path UTF8String];
  if (mmkv::MMKV::getRootDir() != root) {
    @throw [NSException exceptionWithName:@"OmnyoPreferencesIdentity" reason:@"The existing MMKV owner has not initialized its expected root." userInfo:nil];
  }
  return root;
}

BOOL OmnyoPreferenceIntegrityV1(NSString *identifier) {
  auto root = OmnyoPreferenceRootV1(identifier);
  return mmkv::MMKV::isFileValid(identifier.UTF8String, &root);
}

NSDictionary<NSString *, NSString *> *OmnyoPreferenceRecordDigestsV1(NSString *identifier) {
  auto root = OmnyoPreferenceRootV1(identifier);
  if (!mmkv::MMKV::isFileValid(identifier.UTF8String, &root)) {
    @throw [NSException exceptionWithName:@"OmnyoPreferencesIdentity" reason:@"The saved preference store failed its native integrity check." userInfo:nil];
  }
  auto store = mmkv::MMKV::mmkvWithID(identifier.UTF8String, static_cast<mmkv::MMKVMode>(mmkv::MMKV_SINGLE_PROCESS | mmkv::MMKV_READ_ONLY), nullptr, &root);
  if (!store) {
    @throw [NSException exceptionWithName:@"OmnyoPreferencesIdentity" reason:@"The existing preference owner could not be read." userInfo:nil];
  }
  NSMutableDictionary<NSString *, NSString *> *result = [NSMutableDictionary dictionary];
  for (NSString *key in store->allKeysObjC(false)) {
    const auto digest = store->omnyoMigrationRawDigestV1(key);
    if (digest.size() != 64) {
      @throw [NSException exceptionWithName:@"OmnyoPreferencesIdentity" reason:@"A saved preference exceeds the protected comparison bound." userInfo:nil];
    }
    result[key] = [[NSString alloc] initWithBytes:digest.data() length:digest.size() encoding:NSUTF8StringEncoding];
  }
  return result;
}

BOOL OmnyoPreferenceVerifyBeforeAdmissionV1(void) {
  @try {
    NSFileManager *manager = NSFileManager.defaultManager;
    NSURL *documents = [manager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
    NSString *path = [documents URLByAppendingPathComponent:@"mmkv" isDirectory:YES].path;
    NSArray<NSString *> *identities = @[@"bb.preferences", @"omnyo.preferences"];
    BOOL hasStore = NO;
    for (NSString *identity in identities) {
      BOOL data = [manager fileExistsAtPath:[path stringByAppendingPathComponent:identity]];
      BOOL crc = [manager fileExistsAtPath:[path stringByAppendingPathComponent:[identity stringByAppendingString:@".crc"]]];
      if (data != crc) return NO;
      hasStore = hasStore || data;
      if (data) {
        for (NSString *name in @[identity, [identity stringByAppendingString:@".crc"]]) {
          NSDictionary *attributes = [manager attributesOfItemAtPath:[path stringByAppendingPathComponent:name] error:nil];
          if (![attributes[NSFileType] isEqual:NSFileTypeRegular]) return NO;
        }
      }
    }
    if (!hasStore) return YES;
    std::string root(path.UTF8String);
    if (mmkv::MMKV::getRootDir().empty()) mmkv::MMKV::initializeMMKV(root, mmkv::MMKVLogNone);
    if (mmkv::MMKV::getRootDir() != root) return NO;
    for (NSString *identity in identities) {
      if ([manager fileExistsAtPath:[path stringByAppendingPathComponent:identity]] && !mmkv::MMKV::isFileValid(identity.UTF8String, &root)) return NO;
    }
    return YES;
  } @catch (NSException *exception) {
    return NO;
  }
}
