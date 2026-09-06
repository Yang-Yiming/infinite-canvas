import { useMemo } from "react";
import { Button, Dropdown } from "antd";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAssetStore } from "@/stores/use-asset-store";

type CanvasSkillPickerProps = {
    skillId?: string;
    onChange: (skillId?: string) => void;
    buttonClassName?: string;
};

const NONE_KEY = "__skill_none__";
const EMPTY_KEY = "__skill_empty__";

// Lets a canvas node pick a skill asset from "我的资产" to prepend to text-generation prompts.
export function CanvasSkillPicker({ skillId, onChange, buttonClassName }: CanvasSkillPickerProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const assets = useAssetStore((state) => state.assets);
    const skills = useMemo(() => assets.filter((asset) => asset.kind === "skill"), [assets]);
    const selected = skills.find((skill) => skill.id === skillId);

    const items = [
        ...(selected ? [{ key: NONE_KEY, label: t("canvas.skillPicker.none") }] : []),
        ...skills.map((skill) => ({
            key: skill.id,
            label: <span className="block max-w-56 truncate text-xs">{skill.title}</span>,
        })),
        ...(skills.length ? [] : [{ key: EMPTY_KEY, label: t("canvas.skillPicker.empty"), disabled: true }]),
    ];

    return (
        <Dropdown
            trigger={["click"]}
            menu={{
                items,
                selectedKeys: skillId ? [skillId] : [],
                onClick: ({ key }) => onChange(key === NONE_KEY ? undefined : key),
            }}
        >
            <Button
                type="text"
                className={`${buttonClassName || ""} !bg-transparent hover:!bg-black/5 dark:hover:!bg-white/10`}
                style={{ color: theme.node.text }}
                icon={<Sparkles className={selected ? "size-3.5 shrink-0" : "size-3.5 shrink-0 opacity-70"} />}
                aria-label={t("canvas.skillPicker.title")}
            >
                <span className="max-w-28 truncate text-xs">{selected ? selected.title : t("canvas.skillPicker.title")}</span>
            </Button>
        </Dropdown>
    );
}
