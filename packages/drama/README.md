# @video-generate/drama

短剧系列领域类型、Zod 校验器、磁盘布局工具。

## 类型速查

| 类型 | 文件 | 说明 |
|------|------|------|
| `Series` | `series.json` | 系列元数据 + 全局默认参数 |
| `Episode` | `episodes/epXX/episode.json` | 单集元数据 |
| `Character` | `characters/<id>.json` | 角色外观/性格/参考图 |
| `Scene` | `scenes/<id>.json` | 场景环境/气氛/风格锚点 |
| `Shot` | `episodes/epXX/shots/sXXXX.json` | 单镜:镜头语言+prompt+素材 |
| `Asset` | `assets/index.jsonl` | 素材索引(append-only) |
| `GenerationRecord` | 嵌套在 `Shot.generations[]` | 单次生成记录 |
| `Storyboard` | `episodes/epXX/storyboard.json` | 该集 shot 顺序索引 |

## 磁盘布局

```
data/
└── series/
    └── <slug>/
        ├── series.json
        ├── characters/
        │   └── <char_id>.json
        ├── scenes/
        │   └── <scene_id>.json
        ├── episodes/
        │   └── ep01/
        │       ├── episode.json
        │       ├── script.md
        │       ├── storyboard.json
        │       └── shots/
        │           └── s0001.json ... s000N.json
        └── assets/
            ├── images/
            ├── videos/
            ├── audio/
            └── index.jsonl
```

## 使用

```ts
import { parseSeries, seriesDir, shotPath } from "@video-generate/drama";

// 解析并校验
const series = parseSeries(jsonData);

// 路径解析
const dir = seriesDir("my-series");       // data/series/my-series
const shot = shotPath("my-series", "ep01", "s0001");
```

## 测试

```bash
cd C:/Projects/video-studio/myapp/video-generate
npx tsx --test packages/drama/src/test/fixtures.test.ts
```
