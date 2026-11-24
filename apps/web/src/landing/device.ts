export type DeviceOs =
  | "mac"
  | "windows"
  | "ios"
  | "android"
  | "linux"
  | "unknown";

export type DeviceForm = "desktop" | "phone" | "tablet" | "foldable";

export interface Device {
  os: DeviceOs;
  form: DeviceForm;
}

export interface DeviceSignals {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  brandPlatform?: string;
  brandMobile?: boolean;
  shortSide?: number;
  segments?: number;
}

export const UNKNOWN_DEVICE: Device = { os: "unknown", form: "desktop" };

const FOLD_SHORT_SIDE = 600;

const handheld = (signals: DeviceSignals, phone: boolean): DeviceForm => {
  if ((signals.segments ?? 1) > 1) return "foldable";

  if (!phone) return "tablet";

  return (signals.shortSide ?? 0) >= FOLD_SHORT_SIDE ? "foldable" : "phone";
};

export function detectDevice(signals: DeviceSignals): Device {
  const agent = signals.userAgent;
  const brand = signals.brandPlatform ?? "";

  if (/iPhone|iPod/.test(agent)) {
    return { os: "ios", form: handheld(signals, true) };
  }

  const touchMac =
    /Macintosh|MacIntel/.test(`${agent} ${signals.platform ?? ""}`) &&
    (signals.maxTouchPoints ?? 0) > 1;

  if (/iPad/.test(agent) || touchMac) {
    return { os: "ios", form: handheld(signals, false) };
  }

  if (brand === "Android" || /Android/.test(agent)) {
    const phone = signals.brandMobile ?? /Mobile/.test(agent);

    return { os: "android", form: handheld(signals, phone) };
  }

  if (brand === "Windows" || /Windows/.test(agent)) {
    return { os: "windows", form: "desktop" };
  }

  if (brand === "macOS" || /Macintosh|Mac OS X/.test(agent)) {
    return { os: "mac", form: "desktop" };
  }

  if (/CrOS|Linux|X11/.test(`${brand} ${agent}`)) {
    return { os: "linux", form: "desktop" };
  }

  return UNKNOWN_DEVICE;
}

export const DEVICE_SCRIPT = `(function(){try{var n=navigator,a=n.userAgent,d=n.userAgentData||{},b=d.platform||"",t=n.maxTouchPoints||0,s=Math.min(screen.width,screen.height),v=window.visualViewport,g=v&&v.segments?v.segments.length:1,o="unknown",p=true;if(/iPhone|iPod/.test(a))o="ios";else if(/iPad/.test(a)||(/Macintosh|MacIntel/.test(a+" "+(n.platform||""))&&t>1)){o="ios";p=false}else if(b==="Android"||/Android/.test(a)){o="android";p=d.mobile===undefined?/Mobile/.test(a):d.mobile}else if(b==="Windows"||/Windows/.test(a))o="windows";else if(b==="macOS"||/Macintosh|Mac OS X/.test(a))o="mac";else if(/CrOS|Linux|X11/.test(b+" "+a))o="linux";var f="desktop";if(o==="ios"||o==="android")f=g>1?"foldable":!p?"tablet":s>=${FOLD_SHORT_SIDE}?"foldable":"phone";var e=document.documentElement;e.dataset.os=o;e.dataset.form=f}catch(_){}})();`;
