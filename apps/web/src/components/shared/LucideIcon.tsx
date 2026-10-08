import type React from "react";
import { Icon, type IconName } from "./Icon";

type CompatIconProps = Omit<React.SVGProps<SVGSVGElement>, "name"> & {
  size?: number | string;
  color?: string;
  strokeWidth?: number;
};

function toSize(size: number | string | undefined) {
  if (typeof size === "number") return size;
  if (typeof size === "string") {
    const parsed = Number.parseFloat(size);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 16;
}

function makeIcon(name: IconName) {
  return function CompatIcon({ size, className, style, color, strokeWidth, ...rest }: CompatIconProps) {
    return (
      <Icon
        name={name}
        size={toSize(size)}
        className={className}
        strokeWidth={strokeWidth}
        style={{ ...(color ? { color } : null), ...style }}
        {...rest}
      />
    );
  };
}

export const ArrowLeft = makeIcon("arrowLeft");
export const ArrowRight = makeIcon("arrowRight");
export const ChevronLeft = makeIcon("chevLeft");
export const ChevronRight = makeIcon("chevRight");
export const ChevronDown = makeIcon("chevDown");
export const ChevronUp = makeIcon("arrowUp");
export const X = makeIcon("close");
export const Close = makeIcon("close");
export const Plus = makeIcon("plus");
export const Check = makeIcon("check");
export const Search = makeIcon("search");
export const Settings = makeIcon("settings");
export const Settings2 = makeIcon("settings");
export const RefreshCw = makeIcon("refresh");
export const RotateCcw = makeIcon("refresh");
export const Trash = makeIcon("trash");
export const Trash2 = makeIcon("trash");
export const Edit = makeIcon("edit");
export const Pencil = makeIcon("edit");
export const Download = makeIcon("download");
export const Upload = makeIcon("upload");
export const Star = makeIcon("sparkles");
export const Sparkles = makeIcon("sparkles");
export const Wand = makeIcon("wand");
export const Wand2 = makeIcon("wand");
export const Film = makeIcon("film");
export const Video = makeIcon("video");
export const Image = makeIcon("image");
export const ImageIcon = makeIcon("image");
export const User = makeIcon("user");
export const Users = makeIcon("users");
export const Play = makeIcon("play");
export const Pause = makeIcon("pause");
export const MoreHorizontal = makeIcon("more");
export const MoreVertical = makeIcon("more");
export const AlertTriangle = makeIcon("warning");
export const AlertCircle = makeIcon("warning");
export const HelpCircle = makeIcon("help");
export const Clock = makeIcon("clock");
export const Link = makeIcon("link");
export const Link2 = makeIcon("link");
export const GripVertical = makeIcon("grip");
export const GripHorizontal = makeIcon("grip");
export const Eye = makeIcon("eye");
export const Lock = makeIcon("lock");
export const Bookmark = makeIcon("bookmark");
export const FolderOpen = makeIcon("folderOpen");
export const FileText = makeIcon("doc");
export const Loader2 = makeIcon("refresh");
export const Info = makeIcon("info");
export const XCircle = makeIcon("xCircle");
export const CheckCircle = makeIcon("checkCircle");
export const Undo2 = makeIcon("undo");
export const GitCompare = makeIcon("gitCompare");
export const Volume2 = makeIcon("volume");
export const ImagePlus = makeIcon("imagePlus");
export const Coins = makeIcon("coin");
export const Map = makeIcon("map");
export const BookOpen = makeIcon("bookOpen");
export const MessageSquare = makeIcon("message");
export const Heart = makeIcon("heart");
export const FlaskConical = makeIcon("flask");
export const Package = makeIcon("package");
export const MapPin = makeIcon("pin");
export const Moon = makeIcon("moon");
export const Copy = makeIcon("copy");
export const Columns2 = makeIcon("grid");
export const Grid3x3 = makeIcon("grid");
export const PenLine = makeIcon("edit");
export const Maximize2 = makeIcon("expand");
export const Minimize2 = makeIcon("close");
export const Mic = makeIcon("mic");
export const ArrowRightLeft = makeIcon("refresh");
export const Activity = makeIcon("trendUp");
export const ArrowDown = makeIcon("arrowDown");
export const ArrowUp = makeIcon("arrowUp");
export const BarChart3 = makeIcon("trendUp");
export const Brain = makeIcon("sparkles");
export const Brush = makeIcon("wand");
export const Camera = makeIcon("image");
export const CheckCircle2 = makeIcon("checkCircle");
export const Circle = makeIcon("circle");
export const CircleDashed = makeIcon("circle");
export const Clapperboard = makeIcon("film");
export const ClipboardPaste = makeIcon("copy");
export const Code2 = makeIcon("code");
export const Cpu = makeIcon("cpu");
export const Eraser = makeIcon("trash");
export const EyeOff = makeIcon("eye");
export const Factory = makeIcon("server");
export const File = makeIcon("doc");
export const FileJson = makeIcon("doc");
export const FilePlus = makeIcon("doc");
export const FileVideo = makeIcon("video");
export const Gauge = makeIcon("clock");
export const History = makeIcon("history");
export const Home = makeIcon("bookOpen");
export const Images = makeIcon("image");
export const KeyRound = makeIcon("lock");
export const Layers = makeIcon("layers");
export const Lightbulb = makeIcon("help");
export const ListTodo = makeIcon("list");
export const ListVideo = makeIcon("list");
export const MonitorPlay = makeIcon("monitor");
export const PartyPopper = makeIcon("sparkles");
export const Save = makeIcon("save");
export const Server = makeIcon("server");
export const SlidersHorizontal = makeIcon("settings");
export const Square = makeIcon("grid");
export const Subtitles = makeIcon("doc");
export const Sun = makeIcon("spark");
export const TestTube2 = makeIcon("flask");
export const TriangleAlert = makeIcon("warning");
export const Type = makeIcon("type");
export const Unlock = makeIcon("lock");
export const Wallet = makeIcon("coin");
export const Wrench = makeIcon("tool");
export const Zap = makeIcon("zap");
export const ExternalLink = makeIcon("arrowRight");
