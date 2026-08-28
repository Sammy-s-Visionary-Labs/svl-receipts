import { useCallback } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  clamp,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useColorScheme } from "@/components/useColorScheme";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.75;
const AnimatedImage = Animated.createAnimatedComponent(Image);

export function ZoomableReceiptImage({ uri, pageNumber }: { uri: string; pageNumber: number }) {
  const colorScheme = useColorScheme();
  const scale = useSharedValue(MIN_SCALE);
  const scaleAtStart = useSharedValue(MIN_SCALE);

  const pinch = Gesture.Pinch()
    .onBegin(() => {
      scaleAtStart.value = scale.value;
    })
    .onUpdate((event) => {
      scale.value = clamp(scaleAtStart.value * event.scale, MIN_SCALE, MAX_SCALE);
    })
    .onEnd(() => {
      scaleAtStart.value = scale.value;
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const changeZoom = useCallback(
    (amount: number) => {
      const nextScale = clamp(scale.value + amount, MIN_SCALE, MAX_SCALE);
      scale.value = withTiming(nextScale, { duration: 160 });
      scaleAtStart.value = nextScale;
    },
    [scale, scaleAtStart],
  );

  const resetZoom = useCallback(() => {
    scale.value = withTiming(MIN_SCALE, { duration: 160 });
    scaleAtStart.value = MIN_SCALE;
  }, [scale, scaleAtStart]);

  return (
    <View style={styles.container}>
      <GestureDetector gesture={pinch}>
        <Animated.View style={styles.imageViewport}>
          <AnimatedImage
            accessibilityLabel={`Receipt page ${pageNumber}`}
            accessible
            resizeMode="contain"
            source={{ uri }}
            style={[styles.image, animatedStyle]}
          />
        </Animated.View>
      </GestureDetector>
      <View accessibilityRole="toolbar" style={styles.zoomControls}>
        <Pressable
          accessibilityHint="Makes the receipt page smaller"
          accessibilityLabel="Zoom out"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => changeZoom(-ZOOM_STEP)}
          style={styles.zoomButton}
        >
          <Text style={styles.zoomButtonText}>−</Text>
        </Pressable>
        <Pressable
          accessibilityHint="Returns the receipt page to its original size"
          accessibilityLabel="Reset zoom"
          accessibilityRole="button"
          onPress={resetZoom}
          style={styles.resetButton}
        >
          <Text style={styles.resetButtonText}>Reset</Text>
        </Pressable>
        <Pressable
          accessibilityHint="Makes the receipt page larger"
          accessibilityLabel="Zoom in"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => changeZoom(ZOOM_STEP)}
          style={styles.zoomButton}
        >
          <Text style={styles.zoomButtonText}>+</Text>
        </Pressable>
      </View>
      <Text style={[styles.hint, { color: colorScheme === "dark" ? "#cbd5e1" : "#475569" }]}>
        Pinch or use the controls to inspect this page.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: 8,
  },
  imageViewport: {
    flex: 1,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#111827",
    borderRadius: 16,
  },
  image: {
    width: "100%",
    height: "100%",
  },
  zoomControls: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  zoomButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#e8eef7",
  },
  zoomButtonText: {
    color: "#13233a",
    fontSize: 28,
    lineHeight: 30,
    fontWeight: "700",
  },
  resetButton: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 16,
    borderRadius: 22,
    backgroundColor: "#e8eef7",
  },
  resetButtonText: {
    color: "#13233a",
    fontSize: 15,
    fontWeight: "700",
  },
  hint: {
    fontSize: 13,
    textAlign: "center",
  },
});
