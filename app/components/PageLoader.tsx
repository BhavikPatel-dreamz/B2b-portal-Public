import { useNavigation } from "react-router";

export default function PageLoader() {
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  return (
    <>
      {isLoading && (
        <div className="page-loader-bar" style={styles.progressBar}>
          <div className="page-loader-bar-inner" style={styles.progressInner} />
        </div>
      )}
      <style>{`
        @keyframes pageLoaderSpin {
          to { transform: rotate(360deg); }
        }
        @keyframes pageLoaderProgress {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(0%); }
          100% { transform: translateX(100%); }
        }
        .page-loader-bar {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 3px;
          z-index: 9999;
          overflow: hidden;
          background: transparent;
        }
        .page-loader-bar-inner {
          width: 100%;
          height: 100%;
          background: linear-gradient(90deg, #0070f3, #38bdf8, #0070f3);
          animation: pageLoaderProgress 1.2s ease-in-out infinite;
        }
      `}</style>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  progressBar: {
    position: "fixed",
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    zIndex: 9999,
    overflow: "hidden",
    background: "transparent",
  },
  progressInner: {
    width: "100%",
    height: "100%",
    background: "linear-gradient(90deg, #0070f3, #38bdf8, #0070f3)",
    animation: "pageLoaderProgress 1.2s ease-in-out infinite",
  },
};
