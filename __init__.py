"""
ComfyUI-NodeTools
=================

Frontend-only extension. Four canvas actions in the node right-click menu:

    web/nodeInserter.js   insert a node into a link / detach nodes from links
    web/nodeReplacer.js   replace a node / swap the order of two nodes

No backend nodes: NODE_CLASS_MAPPINGS is empty. Every .js under
WEB_DIRECTORY is loaded by ComfyUI as a web extension.
"""

import logging

LOGGER = logging.getLogger(__name__)

# 告诉 ComfyUI 去加载 ./web 下的前端脚本（目录下所有 .js 都会被加载）
WEB_DIRECTORY = "./web"

# 本扩展没有后端节点
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

LOGGER.info("[NodeTools] loaded: nodeInserter.js, nodeReplacer.js")
