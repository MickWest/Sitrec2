# Sitrec Browser Compatability

Sitrec is a web application that will run in any popular desktop browser like Chrome, Safari, Edge, or Firefox. 
However, not all browsers are equal. Below is listed known issues with some browsers.

## Local Filesystem Access

For security reasons not all browsers support local filesystem access. This is required for the local File menu items shown:-

![File System Menu](docimages/ui-local-settings-file.jpg)

| Browser | Capable |
|---------|-----|
| Chrome  | Yes |
| Edge    | Yes |
| Firefox | No  |
| Safari  | Yes |
| Brave   | <em>No by default</em> |

By default Brave Browser has local filesystem access disabled but can be enabled by visiting the [brave://flags/#file-system-access-api](brave://flags/#file-system-access-api)
settings page and ensuring the File System Access API is enabled as shown below. Full details [can be found here](https://github.com/brave/brave-browser/issues/29411#issuecomment-1534565893).

![File System Menu](docimages/brave-settings-file-api.jpg)






