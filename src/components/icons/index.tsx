/**
 * SVG icon components used throughout the application.
 *
 * All icons accept optional `size` (default varies by icon) and `className` props.
 * Icons use `currentColor` for stroke/fill to inherit text color from parent.
 *
 * @module components/icons
 */

interface IconProps {
  size?: number;
  className?: string;
}

export function ChevronIcon({ size = 12, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function CheckIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function WarningIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function ClaudeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 1200 1200" fill="currentColor">
      <path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z" />
    </svg>
  );
}

export function GitHubIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function VercelIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 116 100" fill="currentColor">
      <path d="M57.5 0L115 100H0L57.5 0z" />
    </svg>
  );
}

export function ExternalLinkIcon({ size = 12, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

export function SuccessIcon({ size = 20 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

export function ErrorIcon({ size = 20 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

export function SpinnerIcon({ size = 20, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className || 'spinner-icon'}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

export function CopyIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function ResetIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

export function BranchIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

export function PullRequestIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  );
}

export function CodeIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

export function SearchIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

export function SettingsIcon({ size = 18 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function CameraIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

export function CropIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 2v4M6 18v4M2 6h4M18 6h4M18 2v4M18 18v4M2 18h4M18 18h4" />
      <rect x="6" y="6" width="12" height="12" />
    </svg>
  );
}

export function ChatIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function CloseIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function InfoIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

export function VSCodeIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor">
      <path d="M30.865 3.448l-6.583-3.167c-0.766-0.37-1.677-0.214-2.276 0.385l-12.609 11.505-5.495-4.167c-0.51-0.391-1.229-0.359-1.703 0.073l-1.76 1.604c-0.583 0.526-0.583 1.443-0.005 1.969l4.766 4.349-4.766 4.349c-0.578 0.526-0.578 1.443 0.005 1.969l1.76 1.604c0.479 0.432 1.193 0.464 1.703 0.073l5.495-4.172 12.615 11.51c0.594 0.599 1.505 0.755 2.271 0.385l6.589-3.172c0.693-0.333 1.13-1.031 1.13-1.802v-21.495c0-0.766-0.443-1.469-1.135-1.802zM24.005 23.266l-9.573-7.266 9.573-7.266z" />
    </svg>
  );
}

export function CursorIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
      <path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z" />
    </svg>
  );
}

export function EyeIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export function PanelRightIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
}

export function PlusIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function ImageIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}

export function FolderIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function FileIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

export function TrashIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function EditIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

export function UploadIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

export function DownloadIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function FolderPlusIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}

export function TerminalIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function BugIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2l1.88 1.88" />
      <path d="M14.12 3.88L16 2" />
      <path d="M9 7.13v-1a3.003 3.003 0 116 0v1" />
      <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6" />
      <path d="M12 20v-9" />
      <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
      <path d="M6 13H2" />
      <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
      <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
      <path d="M22 13h-4" />
      <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
    </svg>
  );
}

// Browser Icons

export function SafariIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor">
      <path d="M24.836 7.164l-7.29 10.382-10.382 7.29 7.29-10.382zM17.098 17.098l-2.198-2.198-5.175 7.373 7.372-5.176zM25.778 20.15c0.049-0.112 0.159-0.189 0.287-0.189 0.044 0 0.086 0.009 0.123 0.025l-0.002-0.001 1.15 0.487c0.119 0.046 0.202 0.159 0.202 0.292 0 0.173-0.14 0.312-0.312 0.312-0.048 0-0.094-0.011-0.135-0.031l0.002 0.001-1.15-0.487c-0.113-0.049-0.191-0.159-0.191-0.288 0-0.044 0.009-0.086 0.026-0.124l-0.001 0.002zM4.497 11.118c0.049-0.113 0.159-0.191 0.288-0.191 0.044 0 0.086 0.009 0.124 0.026l-0.002-0.001 1.15 0.489c0.107 0.051 0.179 0.158 0.179 0.283 0 0.173-0.14 0.312-0.312 0.312-0.040 0-0.078-0.007-0.113-0.021l0.002 0.001-1.15-0.487c-0.113-0.049-0.191-0.159-0.191-0.288 0-0.044 0.009-0.086 0.026-0.124l-0.001 0.002zM19.979 25.848c0.035-0.015 0.075-0.023 0.118-0.023 0.13 0 0.242 0.080 0.289 0.193l0.001 0.002 0.467 1.158c0.017 0.037 0.027 0.081 0.027 0.127 0 0.173-0.14 0.312-0.312 0.312-0.134 0-0.248-0.084-0.292-0.202l-0.001-0.002-0.469-1.158c-0.015-0.035-0.023-0.075-0.023-0.118 0-0.13 0.080-0.242 0.193-0.289l0.002-0.001zM11.319 4.413c0.034-0.014 0.075-0.023 0.117-0.023 0.13 0 0.242 0.080 0.289 0.193l0.001 0.002 0.469 1.158c0.015 0.035 0.024 0.077 0.024 0.12 0 0.173-0.14 0.313-0.313 0.313-0.131 0-0.244-0.081-0.29-0.196l-0.001-0.002-0.467-1.158c-0.015-0.035-0.023-0.075-0.023-0.118 0-0.13 0.080-0.242 0.193-0.289l0.002-0.001zM6.152 19.978c0.015 0.035 0.023 0.075 0.023 0.118 0 0.13-0.080 0.242-0.193 0.289l-0.002 0.001-1.158 0.467c-0.037 0.017-0.081 0.027-0.127 0.027-0.173 0-0.312-0.14-0.312-0.312 0-0.134 0.084-0.248 0.202-0.292l0.002-0.001 1.158-0.469c0.035-0.015 0.075-0.023 0.118-0.023 0.13 0 0.242 0.080 0.289 0.193l0.001 0.002zM27.587 11.318c0.014 0.035 0.023 0.075 0.023 0.117 0 0.13-0.080 0.242-0.193 0.289l-0.002 0.001-1.158 0.469c-0.034 0.014-0.074 0.022-0.116 0.022-0.173 0-0.313-0.14-0.313-0.313 0-0.13 0.079-0.241 0.192-0.288l0.002-0.001 1.158-0.467c0.035-0.015 0.075-0.023 0.118-0.023 0.13 0 0.242 0.080 0.289 0.193l0.001 0.002zM11.851 25.778c0.112 0.049 0.19 0.159 0.19 0.287 0 0.044-0.009 0.086-0.025 0.123l0.001-0.002-0.487 1.15c-0.051 0.107-0.158 0.179-0.283 0.179-0.173 0-0.312-0.14-0.312-0.312 0-0.040 0.007-0.078 0.021-0.113l-0.001 0.002 0.487-1.15c0.049-0.113 0.159-0.191 0.288-0.191 0.044 0 0.086 0.009 0.124 0.026l-0.002-0.001zM20.882 4.497c0.113 0.049 0.191 0.159 0.191 0.288 0 0.044-0.009 0.086-0.026 0.124l0.001-0.002-0.489 1.15c-0.046 0.119-0.159 0.202-0.292 0.202-0.173 0-0.312-0.14-0.312-0.312 0-0.048 0.011-0.094 0.031-0.135l-0.001 0.002 0.487-1.15c0.049-0.113 0.159-0.191 0.288-0.191 0.044 0 0.086 0.009 0.124 0.026l-0.002-0.001zM26.622 16c0-0.173 0.14-0.312 0.312-0.312h1.25c0.171 0.001 0.31 0.141 0.31 0.312s-0.138 0.311-0.31 0.312h-1.25c-0.173 0-0.312-0.14-0.312-0.312zM3.504 16c0-0.173 0.14-0.312 0.312-0.312h1.25c0.173 0 0.312 0.14 0.312 0.312s-0.14 0.312-0.312 0.312h-1.25c-0.173 0-0.312-0.14-0.312-0.312zM23.51 23.51c0.057-0.057 0.135-0.092 0.221-0.092s0.165 0.035 0.221 0.092l0.884 0.885c0.064 0.057 0.104 0.14 0.104 0.233 0 0.173-0.14 0.312-0.312 0.312-0.092 0-0.175-0.040-0.233-0.104l-0.885-0.884c-0.057-0.057-0.092-0.135-0.092-0.221s0.035-0.165 0.092-0.221zM7.164 7.165c0.056-0.056 0.134-0.091 0.221-0.091s0.164 0.035 0.221 0.091l0.885 0.883c0.057 0.057 0.092 0.135 0.092 0.221 0 0.173-0.14 0.313-0.313 0.313-0.086 0-0.165-0.035-0.221-0.092l-0.883-0.885c-0.056-0.056-0.091-0.134-0.091-0.221s0.035-0.164 0.091-0.221zM8.49 23.51c0.057 0.057 0.092 0.135 0.092 0.221s-0.035 0.165-0.092 0.221l-0.885 0.884c-0.057 0.064-0.141 0.104-0.233 0.104-0.173 0-0.312-0.14-0.312-0.312 0-0.092 0.040-0.176 0.104-0.233l0.884-0.885c0.057-0.057 0.135-0.092 0.221-0.092s0.165 0.035 0.221 0.092zM24.836 7.164c0.056 0.056 0.091 0.134 0.091 0.221s-0.035 0.164-0.091 0.221l-0.884 0.885c-0.057 0.057-0.135 0.092-0.221 0.092-0.173 0-0.313-0.14-0.313-0.313 0-0.086 0.035-0.165 0.092-0.221l0.885-0.883c0.056-0.056 0.134-0.091 0.221-0.091s0.164 0.035 0.221 0.091zM16 26.622c0.173 0 0.312 0.14 0.312 0.312v1.25c-0.001 0.171-0.141 0.31-0.312 0.31s-0.311-0.138-0.312-0.31v-1.25c0-0.173 0.14-0.312 0.312-0.312zM16 3.504c0.173 0 0.312 0.14 0.312 0.312v1.25c-0.001 0.171-0.141 0.31-0.312 0.31s-0.311-0.138-0.312-0.31v-1.25c0-0.173 0.14-0.312 0.312-0.312zM16 30.058c7.764 0 14.058-6.294 14.058-14.058s-6.294-14.058-14.058-14.058c-7.764 0-14.058 6.294-14.058 14.058 0 7.764 6.294 14.058 14.058 14.058zM16 30.996c-8.282 0-14.996-6.714-14.996-14.996s6.714-14.996 14.996-14.996c8.282 0 14.996 6.714 14.996 14.996-0 8.282-6.714 14.995-14.996 14.996z" />
    </svg>
  );
}

export function ChromeIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 504 504" fill="currentColor">
      <path d="M281.637,362.845c-6.782,2.04-17.047,5.128-29.763,5.128c-22.914,0-44.091-6.253-62.909-18.583c-18.919-12.406-33.28-28.546-42.958-48.481L38.814,113.031l-7.252,12.968C10.671,163.375,0.07,205.703,0.07,251.808c0,62.657,20.69,118.104,61.499,164.788c40.775,46.634,92.227,74.928,152.92,84.069l5.657,0.856l83.96-145.274L281.637,362.845z" />
      <path d="M138.303,220.311c6.329-24.744,20.514-45.803,42.169-62.59c20.354-15.763,43.713-23.426,71.403-23.426h223.836l-7.42-12.641c-21.135-36.05-50.898-64.89-90.977-88.19C339.1,11.256,296.889,0,251.875,0c-39.172,0-76.246,8.444-110.189,25.105c-36.184,17.744-66.921,42.781-88.87,72.435l-3.357,4.541l83.918,137.51L138.303,220.311z" />
      <path d="M484.565,156.93l-2.275-4.801H315.286l14.328,14.328c24.786,24.794,38.434,55.095,38.434,85.345c0,24.173-6.874,46.584-20.749,67.114L240.081,503.747l14.739-0.143c68.541-0.655,127.782-25.81,176.094-74.76c48.279-48.951,72.763-108.519,72.763-177.043C503.677,226.906,500.361,190.235,484.565,156.93z" />
      <path d="M151.155,251.804c0,54.599,46.122,100.721,100.721,100.721c54.599,0,100.721-46.122,100.721-100.721s-46.122-100.721-100.721-100.721C197.277,151.083,151.155,197.205,151.155,251.804z" />
    </svg>
  );
}

export function FirefoxIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor">
      <path d="M11.807 9.776c0.011 0 0.005 0 0 0zM8.109 7.927c0.011 0 0.005 0 0 0zM30.229 10.781c-0.667-1.604-2.021-3.333-3.079-3.885 0.865 1.692 1.365 3.396 1.552 4.661l0.005 0.027c-1.739-4.329-4.681-6.073-7.088-9.871-0.12-0.192-0.24-0.385-0.36-0.588-0.063-0.104-0.115-0.208-0.172-0.319-0.099-0.192-0.171-0.395-0.224-0.609 0-0.020-0.015-0.036-0.036-0.041-0.011 0-0.021 0-0.031 0l-0.005 0.005c-0.005 0-0.011 0.005-0.011 0.005s0-0.005 0.005-0.011c-3.417 2-4.828 5.505-5.193 7.729-1.057 0.063-2.088 0.328-3.041 0.776-0.183 0.093-0.265 0.303-0.197 0.489 0.077 0.213 0.317 0.319 0.525 0.224 0.833-0.391 1.729-0.625 2.651-0.687l0.089-0.011c0.125-0.005 0.255-0.011 0.38-0.011 0.745-0.005 1.489 0.099 2.203 0.307l0.125 0.037c0.12 0.036 0.235 0.077 0.355 0.12 0.083 0.031 0.172 0.063 0.255 0.099 0.068 0.025 0.136 0.057 0.203 0.083 0.105 0.048 0.209 0.1 0.313 0.152l0.14 0.067c0.104 0.053 0.204 0.109 0.303 0.167 0.063 0.037 0.125 0.073 0.187 0.115 1.111 0.688 2.037 1.641 2.683 2.776-0.817-0.572-2.287-1.145-3.697-0.895 5.52 2.76 4.036 12.265-3.615 11.905-0.683-0.025-1.355-0.156-1.995-0.385-0.156-0.057-0.308-0.12-0.453-0.183-0.088-0.041-0.177-0.083-0.26-0.124-1.876-0.969-3.423-2.803-3.615-5.027 0 0 0.708-2.64 5.072-2.64 0.475 0 1.824-1.319 1.849-1.699-0.011-0.125-2.683-1.187-3.724-2.213-0.557-0.547-0.817-0.812-1.052-1.011-0.125-0.109-0.26-0.208-0.401-0.301-0.348-1.224-0.364-2.521-0.041-3.751-1.579 0.719-2.803 1.855-3.693 2.855h-0.009c-0.609-0.771-0.563-3.313-0.532-3.844-0.005-0.036-0.453 0.229-0.511 0.271-0.536 0.385-1.041 0.813-1.5 1.287-0.525 0.531-1.004 1.104-1.437 1.719-0.984 1.396-1.687 2.979-2.057 4.645-0.005 0.021-0.145 0.647-0.249 1.417-0.021 0.12-0.037 0.24-0.052 0.359-0.043 0.292-0.073 0.589-0.089 0.881l-0.005 0.047c-0.009 0.172-0.020 0.339-0.031 0.511v0.077c0 8.48 6.875 15.355 15.355 15.355 7.593 0 13.9-5.516 15.135-12.756 0.027-0.197 0.047-0.395 0.068-0.593 0.307-2.631-0.031-5.401-0.995-7.713z" />
    </svg>
  );
}

export function ArcIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
    </svg>
  );
}

export function BraveIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2L4 6v6c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V6l-8-4zm0 2.18l6 3v5.32c0 4.29-2.98 8.3-6 9.5-3.02-1.2-6-5.21-6-9.5V7.18l6-3zM11 8v5h2V8h-2zm0 6v2h2v-2h-2z" />
    </svg>
  );
}

export function EdgeIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 12c0-4.97-4.03-9-9-9s-9 4.03-9 9c0 2.63 1.13 5 2.94 6.65.14-.98.58-1.93 1.28-2.75C5.83 14.62 5 13.16 5 11.5c0-2.76 2.24-5 5-5 2.38 0 4.37 1.67 4.87 3.9.67-.24 1.38-.4 2.13-.4.69 0 1.36.12 2 .32V12c0 4.97-4.03 9-9 9-.67 0-1.33-.08-1.96-.22.49.14 1 .22 1.53.22 3.18 0 5.75-2.61 5.75-5.83 0-1.07-.29-2.08-.8-2.94-.23.75-.64 1.44-1.2 2.02.32.58.5 1.24.5 1.95 0 2.21-1.79 4-4 4-.87 0-1.68-.28-2.33-.75.91 1.42 2.46 2.36 4.23 2.36 2.76 0 5-2.24 5-5 0-.79-.19-1.54-.52-2.21.34.14.72.21 1.1.21.24 0 .47-.03.7-.08z" />
    </svg>
  );
}

export function GlobeIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

export function ZapIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

export function MoreVerticalIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="19" r="1" />
    </svg>
  );
}

export function ArrowLeftIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 12H5" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

export function CompactIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Minimize/compress arrows pointing inward */}
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

export function ExpandIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Maximize/expand arrows pointing outward */}
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

export function PinIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

export function SendIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export function FullPageIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Document outline */}
      <rect x="4" y="2" width="16" height="20" rx="2" />
      {/* Up arrow */}
      <polyline points="12 6 12 10" />
      <polyline points="9 8 12 5 15 8" />
      {/* Down arrow */}
      <polyline points="12 14 12 18" />
      <polyline points="9 16 12 19 15 16" />
    </svg>
  );
}
