interface IntroContentProps {
  compact?: boolean;
}

export default function IntroContent({ compact = false }: IntroContentProps) {
  if (compact) {
    return (
      <div className="text-center space-y-1.5 sm:space-y-2">
        <p className="text-white/70 text-xs sm:text-sm">Hover over particles to see wiki edits</p>
        <p className="text-white/70 text-xs sm:text-sm">Click particles to open the edit page</p>
        <p className="text-white/70 text-xs sm:text-sm">Tap anywhere to activate sound</p>
      </div>
    );
  }

  return (
    <div className="text-center space-y-3 sm:space-y-4">
      <h1 className="text-white/90 text-xl sm:text-2xl md:text-3xl font-light tracking-widest uppercase">
        Sound of Knowledge
      </h1>
      <div className="space-y-1.5 sm:space-y-2 text-white/50 text-xs sm:text-sm">
        <p>Hover over particles to see wiki edits</p>
        <p>Click particles to open the edit page</p>
        <p>Tap anywhere to activate sound</p>
      </div>
    </div>
  );
}
