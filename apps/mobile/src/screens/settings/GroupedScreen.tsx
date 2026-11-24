import type { ReactNode } from "react";
import { ScrollView } from "react-native";
import Animated, {
  LayoutAnimationConfig,
  LinearTransition,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MOBILE_MOTION_MS } from "@/ui";
import { ConnectionBanner } from "../shell/ConnectionBanner";

const IS_IOS = process.env.EXPO_OS === "ios";

const CONTENT_GAP = 24;

interface GroupedScreenProps {
  children: ReactNode;
  testID?: string;
}

export function GroupedScreen({ children, testID }: GroupedScreenProps) {
  const insets = useSafeAreaInsets();

  return (
    <LayoutAnimationConfig skipEntering>
      <ScrollView
        className="flex-1 bg-surface-grouped"
        testID={testID}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          {
            padding: 16,
            paddingLeft: 16 + insets.left,
            paddingRight: 16 + insets.right,
            gap: CONTENT_GAP,
            paddingBottom: IS_IOS ? 32 : insets.bottom + 32,
          },
          { flexGrow: 1 },
        ]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <ConnectionBanner />
        <Animated.View
          layout={LinearTransition.duration(MOBILE_MOTION_MS.base)}
          style={{ flexGrow: 1, gap: CONTENT_GAP }}
        >
          {children}
        </Animated.View>
      </ScrollView>
    </LayoutAnimationConfig>
  );
}
