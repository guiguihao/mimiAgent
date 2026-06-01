# 按键控制经验
- 对于 Home Assistant 中的 **按钮实体**（`button.xxx`），使用 **`button.press`** 服务进行一次性按键触发。
- 调用方式示例:
  ```json
  {
    "domain": "button",
    "service": "press",
    "target": { "entity_id": "button.<entity_id>" }
  }
  ```
- 必须在请求中提供 **`entity_id`**（或 `device_id`、`area_id` 等任意标识），否则会报错 *must contain at least one of entity_id, device_id, area_id, floor_id, label_id*。
- 按键实体通常对应 **开关切换**、**功能触发**，一次调用即相当于一次点击，适用于“开/关”“一次性动作”。
- 若需要在脚本或自动化中多次控制，同一实体可重复调用 `button.press`。
- 对于 **多路开关**（如三键开关），每一路都有独立的 `button.xxx_toggle_a_<路号>_1` 实体，只需替换对应的 `entity_id` 即可控制指定路。
- 建议在自动化中使用 **模板** 或 **变量** 动态拼接 `entity_id`，提高复用性。
