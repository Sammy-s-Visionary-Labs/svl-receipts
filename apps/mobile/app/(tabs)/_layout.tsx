import { type Href, Link, Redirect, Tabs } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Pressable } from "react-native";
import { useClientOnlyValue } from "@/components/useClientOnlyValue";
import { useColorScheme } from "@/components/useColorScheme";
import Colors from "@/constants/Colors";
import { useAuth } from "@/lib/auth/auth-context";

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const { session, loading } = useAuth();
  const headerShown = useClientOnlyValue(false, true);

  if (loading) {
    return null;
  }
  if (!session) {
    return <Redirect href={"/login" as Href} />;
  }

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme].tint,
        // Disable the static render of the header on web
        // to prevent a hydration error in React Navigation v6.
        headerShown,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Tab One",
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{
                ios: "chevron.left.forwardslash.chevron.right",
                android: "code",
                web: "code",
              }}
              tintColor={color}
              size={28}
            />
          ),
          headerRight: () => (
            <Link href="/modal" asChild>
              <Pressable style={{ marginRight: 15 }}>
                {({ pressed }) => (
                  <SymbolView
                    name={{ ios: "info.circle", android: "info", web: "info" }}
                    size={25}
                    tintColor={Colors[colorScheme].text}
                    style={{ opacity: pressed ? 0.5 : 1 }}
                  />
                )}
              </Pressable>
            </Link>
          ),
        }}
      />
      <Tabs.Screen
        name="two"
        options={{
          title: "Tab Two",
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{
                ios: "chevron.left.forwardslash.chevron.right",
                android: "code",
                web: "code",
              }}
              tintColor={color}
              size={28}
            />
          ),
        }}
      />
    </Tabs>
  );
}
