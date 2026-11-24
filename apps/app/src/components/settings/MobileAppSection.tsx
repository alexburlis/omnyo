import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { PluginMobileSettingsSections } from "@/components/plugin/PluginSettingsSections";
import {
  SettingsRow,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import {
  canOpenNativeScreen,
  nativeShellServerSummary,
  shellOpenNative,
  type NativeShellServerSummary,
} from "@/lib/native-shell";
import { MachineAccessSettings } from "./MachineAccessSettings";
import { IosPlatformIcon } from "./IosPlatformIcon";

function ThisPhoneSection({ phone }: { phone: NativeShellServerSummary }) {
  return (
    <SettingsSection title="This phone">
      <div className="space-y-3">
        <p className="text-sm text-subtle-foreground">
          This phone is using{" "}
          <span className="font-medium break-all text-foreground">
            {phone.host}
          </span>{" "}
          through {phone.mode === "connect" ? "Omnyo connect" : "a direct URL"}.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => shellOpenNative("device-settings")}
        >
          <Icon name="Smartphone" />
          Servers and phone settings
        </Button>
      </div>
    </SettingsSection>
  );
}

export function MobileAppSection() {
  const phone = canOpenNativeScreen() ? nativeShellServerSummary() : null;

  return (
    <section aria-label="Mobile" className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Mobile apps</h2>
        <p className="mt-1 text-sm text-subtle-foreground">
          Use Omnyo from your phone
        </p>
      </div>
      {phone === null ? null : <ThisPhoneSection phone={phone} />}
      <MachineAccessSettings title="Accessing Omnyo from your phone">
        {(pluginId) =>
          phone === null || pluginId === null ? (
            <PluginMobileSettingsSections pluginId={pluginId} />
          ) : (
            <>
              <p className="mt-3 text-xs text-subtle-foreground">
                Any pairing code below is for another phone.
              </p>
              <PluginMobileSettingsSections pluginId={pluginId} />
            </>
          )
        }
      </MachineAccessSettings>
      <SettingsSection title="Apps">
        <SettingsRowList>
          <SettingsRow>
            <IosPlatformIcon />
            <span className="text-foreground">iOS</span>
            <span className="ml-auto text-subtle-foreground">
              Invite only, through TestFlight
            </span>
          </SettingsRow>
        </SettingsRowList>
      </SettingsSection>
    </section>
  );
}
