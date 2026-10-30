@{
    Severity     = @('Error', 'Warning')
    ExcludeRules = @(
        # 安装器是给人看的控制台程序：Write-Host 是有意的（读屏软件读控制台输出）
        'PSAvoidUsingWriteHost',
        # 函数名用复数更贴近用途（New-AroomoShortcuts 一次创建多个）
        'PSUseSingularNouns',
        # 只给脚本内部用的小函数（Invoke-DC、Exit-Aroomo 等）不需要 ShouldProcess
        'PSUseShouldProcessForStateChangingFunctions'
    )
}
