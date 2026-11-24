#include <node_api.h>
#include <Security/Security.h>
#include <unistd.h>
#include <dlfcn.h>
#include "desktop-keychain-query-guard-v1.h"

static napi_value fence(napi_env env, napi_callback_info info) {
  OSStatus status = SecKeychainSetUserInteractionAllowed(false);
  Boolean allowed = true;
  OSStatus inspected = SecKeychainGetUserInteractionAllowed(&allowed);
  if (status != errSecSuccess || inspected != errSecSuccess || allowed) {
    napi_throw_error(env, NULL, "Process-local Keychain interaction could not be disabled");
    return NULL;
  }
  napi_value result, disabled, pid;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_get_boolean(env, true, &disabled) != napi_ok ||
      napi_create_int32(env, getpid(), &pid) != napi_ok ||
      napi_set_named_property(env, result, "interactionNotAllowed", disabled) != napi_ok ||
      napi_set_named_property(env, result, "processId", pid) != napi_ok) {
    napi_throw_error(env, NULL, "Keychain interaction fence result could not be verified");
    return NULL;
  }
  SecKeychainRef keychain=NULL;
  OSStatus keychainStatus=SecKeychainCopyDefault(&keychain);
  SecKeychainStatus keychainFlags=0;
  if (keychainStatus==errSecSuccess) keychainStatus=SecKeychainGetStatus(keychain,&keychainFlags);
  if (keychain) CFRelease(keychain);
  napi_value statusValue,unlockedValue;
  if (napi_create_int32(env,keychainStatus,&statusValue)!=napi_ok ||
      napi_set_named_property(env,result,"defaultKeychainStatus",statusValue)!=napi_ok ||
      napi_get_boolean(env,keychainStatus==errSecSuccess && (keychainFlags&kSecUnlockStateStatus)!=0,&unlockedValue)!=napi_ok ||
      napi_set_named_property(env,result,"defaultKeychainUnlocked",unlockedValue)!=napi_ok) return NULL;
  return result;
}

static napi_value queryGuard(napi_env env, napi_callback_info info) {
  int (*readReport)(OmnyoKeychainQueryGuardReportV1 *)=dlsym(RTLD_DEFAULT,"omnyo_keychain_query_guard_report_v1");
  OmnyoKeychainQueryGuardReportV1 report={0};
  if (!readReport || readReport(&report) || report.version!=1 || report.processId!=getpid() || !report.interactionNotAllowed) {
    napi_throw_error(env,NULL,"Exact process Keychain query guard is unavailable");
    return NULL;
  }
  napi_value result,value;
  if (napi_create_object(env,&result)!=napi_ok) return NULL;
  const char *names[]={"version","processId","observed","matched","denied","forwarded","lastStatus","lastOperation","lastDeniedOperation","lastForwardedOperation","lastForwardedStatus","forwardedReads","forwardedMutations"};
  double numbers[]={report.version,report.processId,report.observed,report.matched,report.denied,report.forwarded,report.lastStatus,report.lastOperation,report.lastDeniedOperation,report.lastForwardedOperation,report.lastForwardedStatus,report.forwardedReads,report.forwardedMutations};
  for (unsigned int index=0;index<13;index++) {
    if (napi_create_double(env,numbers[index],&value)!=napi_ok || napi_set_named_property(env,result,names[index],value)!=napi_ok) return NULL;
  }
  if (napi_get_boolean(env,report.interactionNotAllowed,&value)!=napi_ok || napi_set_named_property(env,result,"interactionNotAllowed",value)!=napi_ok ||
    napi_get_boolean(env,report.defaultDeny,&value)!=napi_ok || napi_set_named_property(env,result,"defaultDeny",value)!=napi_ok ||
    napi_create_string_utf8(env,report.namespaceSha256,NAPI_AUTO_LENGTH,&value)!=napi_ok || napi_set_named_property(env,result,"namespaceSha256",value)!=napi_ok ||
    napi_create_string_utf8(env,report.unexpectedNamespaceSha256,NAPI_AUTO_LENGTH,&value)!=napi_ok || napi_set_named_property(env,result,"unexpectedNamespaceSha256",value)!=napi_ok) return NULL;
  if (napi_get_boolean(env,report.writesAllowed,&value)!=napi_ok || napi_set_named_property(env,result,"writesAllowed",value)!=napi_ok ||
    napi_create_double(env,report.mutationsDenied,&value)!=napi_ok || napi_set_named_property(env,result,"mutationsDenied",value)!=napi_ok) return NULL;
  const char *booleanNames[]={"serviceIsString","accountIsString","serviceMatches","accountMatches","genericPassword","defaultBackend","backendAttributePresent","legacyAccountMatches","backendAttributeIsBoolean","backendAttributeIsFalse","backendAttributeIsTrue"};
  bool booleans[]={report.serviceIsString,report.accountIsString,report.serviceMatches,report.accountMatches,report.genericPassword,report.defaultBackend,report.backendAttributePresent,report.legacyAccountMatches,report.backendAttributeIsBoolean,report.backendAttributeIsFalse,report.backendAttributeIsTrue};
  for (unsigned int index=0;index<11;index++) if (napi_get_boolean(env,booleans[index],&value)!=napi_ok || napi_set_named_property(env,result,booleanNames[index],value)!=napi_ok) return NULL;
  if (napi_create_double(env,report.serviceUtf8Length,&value)!=napi_ok || napi_set_named_property(env,result,"serviceUtf8Length",value)!=napi_ok ||
    napi_create_double(env,report.accountUtf8Length,&value)!=napi_ok || napi_set_named_property(env,result,"accountUtf8Length",value)!=napi_ok ||
    napi_create_string_utf8(env,report.serviceSha256,NAPI_AUTO_LENGTH,&value)!=napi_ok || napi_set_named_property(env,result,"serviceSha256",value)!=napi_ok ||
    napi_create_string_utf8(env,report.accountSha256,NAPI_AUTO_LENGTH,&value)!=napi_ok || napi_set_named_property(env,result,"accountSha256",value)!=napi_ok) return NULL;
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  if (napi_create_function(env, "fence", NAPI_AUTO_LENGTH, fence, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "fence", function) != napi_ok) {
    napi_throw_error(env, NULL, "Keychain interaction fence could not be initialized");
    return NULL;
  }
  if (napi_create_function(env,"queryGuard",NAPI_AUTO_LENGTH,queryGuard,NULL,&function)!=napi_ok ||
    napi_set_named_property(env,exports,"queryGuard",function)!=napi_ok) {
    napi_throw_error(env,NULL,"Keychain query guard metadata could not be bound");
    return NULL;
  }
  return exports;
}
