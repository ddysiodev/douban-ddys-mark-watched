# 豆瓣 DDYS 命中资源标记看过

一个 Tampermonkey 用户脚本，用于在豆瓣电影选电影页读取 DDYS Chrome 插件已经检测出的资源命中缓存，并把这些豆瓣条目批量标记为当前登录豆瓣账号的“看过（私密）”。

## 做了什么

- 读取当前页面 `sessionStorage` 中 DDYS 插件写入的命中资源缓存。
- 提取命中的豆瓣 subject id。
- 使用当前豆瓣登录态和页面 `ck`，向豆瓣接口提交：

```text
POST /j/subject/{subject_id}/interest
interest=collect
private=on
```

这等同于在豆瓣详情页手动点击“看过”并设置为私密。

## 使用方式

1. 安装 Tampermonkey。
2. 新建脚本，将 `douban-ddys-mark-watched.user.js` 内容粘贴进去并保存。
3. 登录豆瓣账号。
4. 打开 `https://movie.douban.com/explore`。
5. 等 DDYS Chrome 插件检测出“去观看”条目。
6. 点击脚本面板里的“刷新计数”，确认待标记数量。
7. 点击“开始POST”。

## 注意

- 这个脚本不会保存你的豆瓣账号数据，也不包含任何 token。
- 本地 `localStorage` 只用于避免同一 subject id 重复提交。
- 如果豆瓣要求验证或重新登录，脚本会停止。
- 建议小批量、慢速执行，避免频繁请求触发风控。
