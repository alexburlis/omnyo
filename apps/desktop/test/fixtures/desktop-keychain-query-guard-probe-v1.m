#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <dlfcn.h>
#include <string.h>
#include <unistd.h>
#include "../../src/desktop-keychain-query-guard-v1.h"
#ifndef OMNYO_QUERY_NAMESPACE
#error Exact synthetic namespace is required
#endif
#if OMNYO_QUERY_MATCH_MATRIX
static BOOL matchMatrixCall(CFTypeRef query, uint32_t operation, CFDictionaryRef changes, BOOL *eligible) {
  OmnyoKeychainQueryGuardReportV1 before={0},after={0};
  if (omnyo_keychain_query_guard_report_v1(&before)) return NO;
  CFTypeRef value=NULL;
  OSStatus status=operation==1 ? SecItemAdd((CFDictionaryRef)query,&value) :
    operation==2 ? SecItemUpdate((CFDictionaryRef)query,changes) :
    operation==3 ? SecItemDelete((CFDictionaryRef)query) : SecItemCopyMatching((CFDictionaryRef)query,&value);
  BOOL noData=value==NULL;
  if(value)CFRelease(value);
  if (omnyo_keychain_query_guard_report_v1(&after) || status!=errSecAuthFailed || !noData ||
    after.observed!=before.observed+1 || after.denied!=before.denied+1 || after.forwarded!=0 ||
    after.forwardedReads!=0 || after.forwardedMutations!=0 || !after.defaultDeny ||
    after.writesAllowed || !after.interactionNotAllowed) return NO;
  *eligible=after.matched==before.matched+1;
  return YES;
}
int main(void) {
  @autoreleasepool {
    alarm(3);
    OmnyoKeychainQueryGuardReportV1 initial={0};
    Dl_info queryImage={0},guardImage={0};
    if (omnyo_keychain_query_guard_report_v1(&initial) || !initial.interactionNotAllowed || !initial.defaultDeny || initial.writesAllowed || initial.observed!=0 ||
      !dladdr((void *)SecItemCopyMatching,&queryImage) || !dladdr((void *)omnyo_keychain_query_guard_report_v1,&guardImage) || strcmp(queryImage.dli_fname,guardImage.dli_fname)!=0) return 3;
    NSDictionary *canonical=@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService:@OMNYO_QUERY_NAMESPACE " Safe Storage",(__bridge id)kSecAttrAccount:@OMNYO_QUERY_NAMESPACE " Key",(__bridge id)kSecReturnData:@YES};
    NSMutableDictionary *bare=[canonical mutableCopy];
    bare[(__bridge id)kSecAttrAccount]=@OMNYO_QUERY_NAMESPACE;
    BOOL canonicalRead=NO,bareRead=NO;
    if (!matchMatrixCall((__bridge CFTypeRef)canonical,0,NULL,&canonicalRead) ||
      !matchMatrixCall((__bridge CFTypeRef)bare,0,NULL,&bareRead)) return 4;
    NSMutableDictionary *negative=[NSMutableDictionary dictionary];
    NSMutableDictionary *changed=[canonical mutableCopy];
    changed[(__bridge id)kSecAttrService]=@OMNYO_QUERY_NAMESPACE " Unselected"; negative[@"foreignService"]=changed;
    changed=[canonical mutableCopy]; changed[(__bridge id)kSecAttrAccount]=@OMNYO_QUERY_NAMESPACE " Foreign"; negative[@"foreignAccount"]=changed;
    changed=[canonical mutableCopy]; changed[(__bridge id)kSecClass]=(__bridge id)kSecClassInternetPassword; negative[@"foreignClass"]=changed;
    changed=[canonical mutableCopy]; changed[(__bridge id)kSecUseDataProtectionKeychain]=@YES; negative[@"otherBackend"]=changed;
    changed=[canonical mutableCopy]; changed[(__bridge id)kSecUseDataProtectionKeychain]=@NO; negative[@"explicitBackend"]=changed;
    changed=[canonical mutableCopy]; changed[(__bridge id)kSecAttrService]=@1; negative[@"nonStringService"]=changed;
    changed=[canonical mutableCopy]; changed[(__bridge id)kSecAttrAccount]=@1; negative[@"nonStringAccount"]=changed;
    changed=[canonical mutableCopy]; [changed removeObjectForKey:(__bridge id)kSecAttrAccount]; negative[@"missingAccount"]=changed;
    changed=[canonical mutableCopy]; changed[(__bridge id)kSecAttrService]=@"BB Private Safe Storage"; changed[(__bridge id)kSecAttrAccount]=@"BB Private Key"; negative[@"productionOld"]=changed;
    changed=[canonical mutableCopy]; changed[(__bridge id)kSecAttrService]=@"Omnyo Private Safe Storage"; changed[(__bridge id)kSecAttrAccount]=@"Omnyo Private Key"; negative[@"productionNew"]=changed;
    NSMutableDictionary *denied=[NSMutableDictionary dictionary];
    for (NSString *key in negative) {
      BOOL eligible=NO;
      if (!matchMatrixCall((__bridge CFTypeRef)negative[key],0,NULL,&eligible)) return 5;
      denied[key]=(eligible ? @NO : @YES);
    }
    for (NSNumber *operation in @[@1,@2,@3]) {
      BOOL eligible=NO;
      NSDictionary *changes=@{(__bridge id)kSecValueData:[NSData data]};
      if (!matchMatrixCall((__bridge CFTypeRef)bare,operation.unsignedIntValue,(__bridge CFDictionaryRef)changes,&eligible)) return 6;
      denied[[@"bareMutation" stringByAppendingString:operation.stringValue]]=(eligible ? @NO : @YES);
    }
    BOOL eligible=NO;
    NSDictionary *changes=@{(__bridge id)kSecAttrAccount:@OMNYO_QUERY_NAMESPACE " Foreign"};
    if (!matchMatrixCall((__bridge CFTypeRef)canonical,2,(__bridge CFDictionaryRef)changes,&eligible)) return 7;
    denied[@"identityChangingUpdate"]=(eligible ? @NO : @YES);
    if (!matchMatrixCall((__bridge CFTypeRef)@[],0,NULL,&eligible)) return 8;
    denied[@"nonDictionary"]=(eligible ? @NO : @YES);
    OmnyoKeychainQueryGuardReportV1 final={0};
    if (omnyo_keychain_query_guard_report_v1(&final)) return 9;
    NSDictionary *result=@{@"version":@1,@"mode":@"finite-synthetic-account-matrix-v1",@"canonicalReadEligible":@(canonicalRead),@"bareReadEligible":@(bareRead),@"deniedControls":denied,
      @"observed":@(final.observed),@"matched":@(final.matched),@"denied":@(final.denied),@"forwarded":@(final.forwarded),@"forwardedReads":@(final.forwardedReads),@"forwardedMutations":@(final.forwardedMutations),
      @"interactionNotAllowed":@(final.interactionNotAllowed),@"defaultDeny":@(final.defaultDeny),@"writesAllowed":@(final.writesAllowed),@"namespaceSha256":[NSString stringWithUTF8String:final.namespaceSha256]};
    NSData *bytes=[NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    return write(STDOUT_FILENO,bytes.bytes,bytes.length)==bytes.length ? 0 : 10;
  }
}
#elif OMNYO_QUERY_PRESERVE_OPTIONS
int main(int argc, const char **argv) {
  @autoreleasepool {
    alarm(3);
    BOOL owner=argc==2 && strcmp(argv[1],"owner")==0;
    BOOL denied=argc==2 && strcmp(argv[1],"denied")==0;
    if (!owner && !denied) return 3;
    OmnyoKeychainQueryGuardReportV1 initial={0};
    Dl_info queryImage={0},guardImage={0};
    if (omnyo_keychain_query_guard_report_v1(&initial) || !initial.interactionNotAllowed || initial.defaultDeny || initial.writesAllowed || initial.observed!=0 ||
      !dladdr((void *)SecItemCopyMatching,&queryImage) || !dladdr((void *)omnyo_keychain_query_guard_report_v1,&guardImage) || strcmp(queryImage.dli_fname,guardImage.dli_fname)!=0) return 4;
    for (NSString *name in @[@OMNYO_QUERY_NAMESPACE,@"BB Private",@"Omnyo Private"]) {
      BOOL synthetic=[name isEqual:@OMNYO_QUERY_NAMESPACE];
      NSString *service=[name stringByAppendingString:synthetic ? @" Unselected" : @" Safe Storage"];
      NSDictionary *query=@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService:service,(__bridge id)kSecAttrAccount:[name stringByAppendingString:@" Key"],(__bridge id)kSecReturnData:@YES};
      CFTypeRef value=NULL;
      OSStatus status=SecItemCopyMatching((__bridge CFDictionaryRef)query,&value);
      if (status!=errSecAuthFailed || value) {if(value)CFRelease(value);return 5;}
    }
    OmnyoKeychainQueryGuardReportV1 negatives={0};
    if (omnyo_keychain_query_guard_report_v1(&negatives) || negatives.forwarded!=0 || negatives.denied!=3 || negatives.observed!=3) return 6;
    NSDictionary *query=@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService:@OMNYO_QUERY_NAMESPACE " Safe Storage",(__bridge id)kSecAttrAccount:@OMNYO_QUERY_NAMESPACE " Key",(__bridge id)kSecReturnData:@YES};
    CFTypeRef value=NULL;
    OSStatus status=SecItemCopyMatching((__bridge CFDictionaryRef)query,&value);
    BOOL dataReturned=value && CFGetTypeID(value)==CFDataGetTypeID();
    if(value)CFRelease(value);
    OmnyoKeychainQueryGuardReportV1 final={0};
    if (omnyo_keychain_query_guard_report_v1(&final) || final.observed!=4 || final.forwarded!=1 || final.forwardedReads!=1 || final.forwardedMutations!=0 || final.denied!=3 || final.matched!=1 || !final.interactionNotAllowed ||
      final.lastForwardedStatus!=status || (owner && (status!=errSecSuccess || !dataReturned)) || (denied && (status!=errSecAuthFailed || dataReturned))) return 7;
    NSDictionary *result=@{@"version":@1,@"queryPolicy":@"production-ui-fence",@"queryOptionsUnchanged":@YES,@"osStatus":@(status),@"dataReturned":@(dataReturned),@"interactionNotAllowed":@YES,@"unknownAndProductionQueriesDenied":@3,@"forwardedReads":@1,@"forwardedMutations":@0};
    NSData *bytes=[NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    return write(STDOUT_FILENO,bytes.bytes,bytes.length)==bytes.length ? 0 : 8;
  }
}
#else
int main(void) {
  @autoreleasepool {
    alarm(3);
    OmnyoKeychainQueryGuardReportV1 initial={0};
    Dl_info queryImage={0}, guardImage={0};
    if (omnyo_keychain_query_guard_report_v1(&initial) || !initial.interactionNotAllowed || !initial.defaultDeny || initial.forwarded!=0 ||
      !dladdr((void *)SecItemCopyMatching,&queryImage) || !dladdr((void *)omnyo_keychain_query_guard_report_v1,&guardImage) ||
      strcmp(queryImage.dli_fname,guardImage.dli_fname)!=0) return 3;
    NSDictionary *expected=@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService:@OMNYO_QUERY_NAMESPACE " Safe Storage",(__bridge id)kSecAttrAccount:@OMNYO_QUERY_NAMESPACE " Key"};
    NSDictionary *other=@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService:@OMNYO_QUERY_NAMESPACE " Unselected",(__bridge id)kSecAttrAccount:@OMNYO_QUERY_NAMESPACE " Key"};
    OSStatus expectedStatus=SecItemCopyMatching((__bridge CFDictionaryRef)expected,NULL);
    OSStatus otherStatus=SecItemCopyMatching((__bridge CFDictionaryRef)other,NULL);
    OmnyoKeychainQueryGuardReportV1 report={0};
    if (omnyo_keychain_query_guard_report_v1(&report) || expectedStatus!=errSecAuthFailed || otherStatus!=errSecAuthFailed ||
      report.observed!=2 || report.matched!=1 || report.denied!=2 || report.forwarded!=0 || !report.interactionNotAllowed || !report.defaultDeny) return 1;
    NSDictionary *result=@{@"version":@1,@"noQueriesForwarded":@YES,@"expectedDenied":@YES,@"unselectedDenied":@YES,
      @"interactionNotAllowed":@YES,@"observed":@(report.observed),@"matched":@(report.matched),@"osStatus":@(otherStatus)};
    NSData *bytes=[NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    return write(STDOUT_FILENO,bytes.bytes,bytes.length)==bytes.length ? 0 : 2;
  }
}

#endif
