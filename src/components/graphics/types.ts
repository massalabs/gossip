export interface GraphicProps {
  size?: number; // Size in pixels (default: 300)
  className?: string;
  loading?: boolean; // Special loading animation mode
  outerColor?: string; // Outer body Tailwind fill class (default: fill-graphic-accent)
  innerColor?: string; // Inner body Tailwind fill class (default: fill-card)
  detailColor?: string; // Detail elements Tailwind fill class (default: fill-foreground)
  scale?: number; // Scale factor for the graphic content (default: 2.0 for Lock/GroupChat, 1.0 for Privacy)
}
