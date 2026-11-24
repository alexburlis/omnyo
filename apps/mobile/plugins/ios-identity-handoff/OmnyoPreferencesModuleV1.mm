#import <React/RCTBridgeModule.h>
#import "OmnyoPreferencesRecordsV1.h"

@interface OmnyoPreferencesIdentityV1 : NSObject <RCTBridgeModule>
@end

@implementation OmnyoPreferencesIdentityV1
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(recordDigestsV1:(NSString *)identifier) {
  @try {
    return @{@"ok": @YES, @"records": OmnyoPreferenceRecordDigestsV1(identifier)};
  } @catch (NSException *exception) {
    return @{@"ok": @NO, @"message": exception.reason ?: @"The native preference owner refused the comparison."};
  }
}
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(integrityV1:(NSString *)identifier) {
  return @(OmnyoPreferenceIntegrityV1(identifier));
}
@end
