import { Tabs } from "expo-router";
import { SymbolView } from "expo-symbols";
import { AuthGate } from "@/components/AuthGate";
import { useClientOnlyValue } from "@/components/useClientOnlyValue";
import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const headerShown = useClientOnlyValue(false, true);

  return (
    <AuthGate allow="tabs">
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: Colors[colorScheme].tint,
          headerShown,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Capture",
            tabBarIcon: ({ color }) => (
              <SymbolView
                name={{ ios: "camera.fill", android: "photo_camera", web: "photo_camera" }}
                tintColor={color}
                size={28}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="recent"
          options={{
            title: "My recent uploads",
            tabBarLabel: "Recent",
            tabBarIcon: ({ color }) => (
              <SymbolView
                name={{ ios: "clock.fill", android: "schedule", web: "schedule" }}
                tintColor={color}
                size={28}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: "Profile",
            tabBarIcon: ({ color }) => (
              <SymbolView
                name={{ ios: "person.fill", android: "person", web: "person" }}
                tintColor={color}
                size={28}
              />
            ),
          }}
        />
      </Tabs>
    </AuthGate>
  );
}
