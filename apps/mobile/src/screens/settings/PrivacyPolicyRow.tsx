import { Linking } from "react-native";
import { describeError } from "@/lib/describe-error";
import { GroupedRow, toast } from "@/ui";

export function PrivacyPolicyRow() {
  return (
    <GroupedRow
      title="Privacy policy"
      trailing="chevron"
      accessibilityLabel="Privacy policy, opens in your browser"
      testID="privacy-policy-link"
      onPress={() => {
        Linking.openURL("https://omnyohq.com/privacy").catch(
          (error: unknown) => {
            toast.error("Could not open the privacy policy", {
              description: describeError(error),
            });
          },
        );
      }}
    />
  );
}
