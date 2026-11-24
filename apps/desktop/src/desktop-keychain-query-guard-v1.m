#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <CommonCrypto/CommonDigest.h>
#include <dlfcn.h>
#include <pthread.h>
#include <unistd.h>
#include "desktop-keychain-query-guard-v1.h"
#ifndef OMNYO_QUERY_NAMESPACE
#error Exact synthetic namespace is required
#endif
#ifndef OMNYO_QUERY_FORWARD_EXACT
#define OMNYO_QUERY_FORWARD_EXACT 0
#endif
#ifndef OMNYO_QUERY_ALLOW_WRITE
#define OMNYO_QUERY_ALLOW_WRITE 0
#endif
#ifndef OMNYO_QUERY_PRESERVE_OPTIONS
#define OMNYO_QUERY_PRESERVE_OPTIONS 0
#endif
#if OMNYO_QUERY_PRESERVE_OPTIONS != 0 && OMNYO_QUERY_PRESERVE_OPTIONS != 1
#error Exact query policy is required
#endif
static pthread_mutex_t reportLock = PTHREAD_MUTEX_INITIALIZER;
static OmnyoKeychainQueryGuardReportV1 metadata = { .version=1, .defaultDeny=!OMNYO_QUERY_FORWARD_EXACT, .writesAllowed=OMNYO_QUERY_ALLOW_WRITE };
static BOOL sealedNamespace=NO;
static void *security = NULL;
static pthread_once_t securityOnce = PTHREAD_ONCE_INIT;
static void openSecurity(void) {
  security = dlopen("/System/Library/Frameworks/Security.framework/Versions/A/Security",RTLD_NOW|RTLD_LOCAL);
}
static void dataHash(NSData *input, char result[65]) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(input.bytes,(CC_LONG)input.length,digest);
  for (unsigned int i=0;i<CC_SHA256_DIGEST_LENGTH;i++) snprintf(result+2*i,3,"%02x",digest[i]);
}
static void namespaceHash(NSString *service, NSString *account, char result[65]) {
  NSMutableData *input = [[service dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
  unsigned char separator=0;
  [input appendBytes:&separator length:1];
  [input appendData:[account dataUsingEncoding:NSUTF8StringEncoding]];
  dataHash(input,result);
}
static BOOL disableInteraction(void) {
  Boolean allowed=true;
  return SecKeychainSetUserInteractionAllowed(false)==errSecSuccess &&
    SecKeychainGetUserInteractionAllowed(&allowed)==errSecSuccess && !allowed;
}
__attribute__((constructor)) static void initializeGuard(void) {
  @autoreleasepool {
    NSString *name=@OMNYO_QUERY_NAMESPACE;
    sealedNamespace=[name rangeOfString:@"^Omnyo Closed Transfer [a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12} (Legacy|Current)$" options:NSRegularExpressionSearch].location!=NSNotFound;
    metadata.processId=getpid();
    metadata.interactionNotAllowed=disableInteraction();
    namespaceHash(@OMNYO_QUERY_NAMESPACE " Safe Storage",@OMNYO_QUERY_NAMESPACE " Key",metadata.namespaceSha256);
  }
}
static NSMutableDictionary *guarded(CFDictionaryRef input, CFDictionaryRef changes, BOOL mutation, uint32_t operation) {
  @autoreleasepool {
    BOOL dictionary=input && CFGetTypeID(input)==CFDictionaryGetTypeID();
    NSDictionary *query=dictionary ? (__bridge NSDictionary *)input : nil;
    NSString *service=query[(__bridge id)kSecAttrService];
    NSString *account=query[(__bridge id)kSecAttrAccount];
    BOOL strings=[service isKindOfClass:NSString.class] && [account isKindOfClass:NSString.class];
    BOOL exact=sealedNamespace && strings && [query[(__bridge id)kSecClass] isEqual:(__bridge id)kSecClassGenericPassword] &&
      [service isEqual:@OMNYO_QUERY_NAMESPACE " Safe Storage"] &&
      ([account isEqual:@OMNYO_QUERY_NAMESPACE " Key"] || (!mutation && [account isEqual:@OMNYO_QUERY_NAMESPACE])) &&
      !query[(__bridge id)kSecUseDataProtectionKeychain];
    if (changes) {
      if (CFGetTypeID(changes)!=CFDictionaryGetTypeID()) exact=NO;
      else for (id key in @[(__bridge id)kSecClass,(__bridge id)kSecAttrService,(__bridge id)kSecAttrAccount]) {
        id value=[(__bridge NSDictionary *)changes objectForKey:key];
        if (value && ![value isEqual:query[key]]) exact=NO;
      }
    }
    BOOL disabled=disableInteraction();
    pthread_mutex_lock(&reportLock);
    metadata.observed++;
    metadata.lastOperation=operation;
    metadata.serviceIsString=[service isKindOfClass:NSString.class];
    metadata.accountIsString=[account isKindOfClass:NSString.class];
    metadata.serviceMatches=strings && [service isEqual:@OMNYO_QUERY_NAMESPACE " Safe Storage"];
    metadata.accountMatches=strings && [account isEqual:@OMNYO_QUERY_NAMESPACE " Key"];
    metadata.legacyAccountMatches=strings && [account isEqual:@OMNYO_QUERY_NAMESPACE];
    metadata.genericPassword=[query[(__bridge id)kSecClass] isEqual:(__bridge id)kSecClassGenericPassword];
    metadata.defaultBackend=!query[(__bridge id)kSecUseDataProtectionKeychain];
    CFTypeRef backend=(__bridge CFTypeRef)query[(__bridge id)kSecUseDataProtectionKeychain];
    metadata.backendAttributePresent=backend!=NULL;
    metadata.backendAttributeIsBoolean=backend && CFGetTypeID(backend)==CFBooleanGetTypeID();
    metadata.backendAttributeIsFalse=backend==kCFBooleanFalse;
    metadata.backendAttributeIsTrue=backend==kCFBooleanTrue;
    if (strings) {
      NSData *serviceBytes=[service dataUsingEncoding:NSUTF8StringEncoding];
      NSData *accountBytes=[account dataUsingEncoding:NSUTF8StringEncoding];
      metadata.serviceUtf8Length=serviceBytes.length;
      metadata.accountUtf8Length=accountBytes.length;
      dataHash(serviceBytes,metadata.serviceSha256);
      dataHash(accountBytes,metadata.accountSha256);
    }
    metadata.interactionNotAllowed=disabled;
    if (exact) metadata.matched++;
    else if (strings) namespaceHash(service,account,metadata.unexpectedNamespaceSha256);
    BOOL forward=exact && disabled && OMNYO_QUERY_FORWARD_EXACT && (!mutation || OMNYO_QUERY_ALLOW_WRITE);
    if (mutation && !OMNYO_QUERY_ALLOW_WRITE) metadata.mutationsDenied++;
    if (forward) {
      metadata.forwarded++;
      if (mutation) metadata.forwardedMutations++; else metadata.forwardedReads++;
    } else {
      metadata.denied++;
      metadata.lastDeniedOperation=operation;
      metadata.lastStatus=errSecAuthFailed;
    }
    pthread_mutex_unlock(&reportLock);
    if (!forward) return nil;
#if OMNYO_QUERY_PRESERVE_OPTIONS
    NSMutableDictionary *result=[query mutableCopy];
    if (!result || !CFEqual((__bridge CFDictionaryRef)result,input)) return nil;
    return result;
#else
    LAContext *context=[[LAContext alloc] init];
    context.interactionNotAllowed=YES;
    NSMutableDictionary *result=[query mutableCopy];
    result[(__bridge id)kSecUseAuthenticationUI]=(__bridge id)kSecUseAuthenticationUIFail;
    result[(__bridge id)kSecUseAuthenticationContext]=context;
    return result;
#endif
  }
}
static OSStatus finished(OSStatus result, uint32_t operation) {
  pthread_mutex_lock(&reportLock);
  metadata.lastStatus=result;
  metadata.lastForwardedOperation=operation;
  metadata.lastForwardedStatus=result;
  pthread_mutex_unlock(&reportLock);
  return result;
}
OSStatus SecItemCopyMatching(CFDictionaryRef query, CFTypeRef *result) {
  @autoreleasepool {
    if (result) *result=NULL;
    NSDictionary *safe=guarded(query,NULL,NO,0);
    if (!safe) return errSecAuthFailed;
    pthread_once(&securityOnce,openSecurity);
    OSStatus (*original)(CFDictionaryRef,CFTypeRef *)=security ? dlsym(security,"SecItemCopyMatching") : NULL;
    return finished(original ? original((__bridge CFDictionaryRef)safe,result) : errSecNotAvailable,0);
  }
}
OSStatus SecItemAdd(CFDictionaryRef query, CFTypeRef *result) {
  @autoreleasepool {
    if (result) *result=NULL;
    NSDictionary *safe=guarded(query,NULL,YES,1);
    if (!safe) return errSecAuthFailed;
    pthread_once(&securityOnce,openSecurity);
    OSStatus (*original)(CFDictionaryRef,CFTypeRef *)=security ? dlsym(security,"SecItemAdd") : NULL;
    return finished(original ? original((__bridge CFDictionaryRef)safe,result) : errSecNotAvailable,1);
  }
}
OSStatus SecItemUpdate(CFDictionaryRef query, CFDictionaryRef changes) {
  @autoreleasepool {
    NSDictionary *safe=guarded(query,changes,YES,2);
    if (!safe) return errSecAuthFailed;
    pthread_once(&securityOnce,openSecurity);
    OSStatus (*original)(CFDictionaryRef,CFDictionaryRef)=security ? dlsym(security,"SecItemUpdate") : NULL;
    return finished(original ? original((__bridge CFDictionaryRef)safe,changes) : errSecNotAvailable,2);
  }
}
OSStatus SecItemDelete(CFDictionaryRef query) {
  @autoreleasepool {
    NSDictionary *safe=guarded(query,NULL,YES,3);
    if (!safe) return errSecAuthFailed;
    pthread_once(&securityOnce,openSecurity);
    OSStatus (*original)(CFDictionaryRef)=security ? dlsym(security,"SecItemDelete") : NULL;
    return finished(original ? original((__bridge CFDictionaryRef)safe) : errSecNotAvailable,3);
  }
}
int omnyo_keychain_query_guard_report_v1(OmnyoKeychainQueryGuardReportV1 *result) {
  if (!result) return 1;
  pthread_mutex_lock(&reportLock);
  *result=metadata;
  pthread_mutex_unlock(&reportLock);
  return 0;
}
