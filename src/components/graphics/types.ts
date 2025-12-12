export interface GraphicProps {
  size?: number; // Size in pixels (default: 300)
  className?: string;
  loading?: boolean; // Special loading animation mode
  outerColor?: string; // Outer body Tailwind fill class (default: fill-graphic-accent)
  innerColor?: string; // Inner body Tailwind fill class (default: fill-card)
  detailColor?: string; // Detail elements Tailwind fill class (default: fill-foreground)
}
