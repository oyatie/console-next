# SPDX-License-Identifier: LicenseRef-Proprietary
package main
import rego.v1

podspec := input.spec if input.kind == "Pod"
podspec := input.spec.template.spec if input.kind in {"Deployment", "Rollout", "Job", "StatefulSet", "DaemonSet", "ReplicaSet"}
podspec := input.spec.jobTemplate.spec.template.spec if input.kind == "CronJob"
containers contains c if c := podspec.containers[_]
containers contains c if c := podspec.initContainers[_]
containers contains c if c := podspec.ephemeralContainers[_]

deny contains "PLAT_IMAGE_DIGEST: images must use sha256 digests" if {
    c := containers[_]
    not regex.match(`^([^/@]+/)*[^/:@]+@sha256:[a-f0-9]{64}$`, c.image)
}
deny contains "PLAT_IMAGE_DIGEST: database image must use a sha256 digest" if {
    input.kind == "Cluster"
    not regex.match(`^([^/@]+/)*[^/:@]+@sha256:[a-f0-9]{64}$`, input.spec.imageName)
}
deny contains "PLAT_NON_ROOT: workloads must run as non-root" if {
    object.get(object.get(podspec, "securityContext", {}), "runAsNonRoot", false) != true
}
deny contains "PLAT_NON_ROOT: containers cannot override the pod with root" if {
    c := containers[_]
    sc := object.get(c, "securityContext", {})
    object.get(sc, "runAsUser", -1) == 0
}
deny contains "PLAT_NON_ROOT: containers cannot disable runAsNonRoot" if {
    c := containers[_]
    object.get(object.get(c, "securityContext", {}), "runAsNonRoot", true) == false
}
deny contains "PLAT_READ_ONLY: containers need a read-only root filesystem" if {
    c := containers[_]
    object.get(object.get(c, "securityContext", {}), "readOnlyRootFilesystem", false) != true
}
deny contains "PLAT_RESOURCES: CPU and memory requests and limits are required" if {
    c := containers[_]
    some group in {"requests", "limits"}
    some resource in {"cpu", "memory"}
    object.get(object.get(object.get(c, "resources", {}), group, {}), resource, "") in {"", "0", 0}
}
deny contains "PLAT_HOST_PATH: hostPath volumes are forbidden" if {
    podspec.volumes[_].hostPath
}
deny contains "PLAT_HOST_NAMESPACE: host namespaces are forbidden" if {
    some field in {"hostNetwork", "hostPID", "hostIPC"}
    object.get(podspec, field, false) == true
}
deny contains "PLAT_PRIVILEGE: containers must drop ALL capabilities and refuse escalation" if {
    c := containers[_]
    sc := object.get(c, "securityContext", {})
    object.get(sc, "allowPrivilegeEscalation", true) != false
}
deny contains "PLAT_PRIVILEGE: privileged containers are forbidden" if {
    c := containers[_]
    object.get(object.get(c, "securityContext", {}), "privileged", false) == true
}
deny contains "PLAT_PRIVILEGE: ALL capabilities must be dropped" if {
    c := containers[_]
    not "ALL" in object.get(object.get(object.get(c, "securityContext", {}), "capabilities", {}), "drop", [])
}
deny contains "PLAT_PRIVILEGE: added capabilities are forbidden" if {
    c := containers[_]
    count(object.get(object.get(object.get(c, "securityContext", {}), "capabilities", {}), "add", [])) > 0
}
deny contains "PLAT_SECCOMP: RuntimeDefault seccomp is required" if {
    object.get(object.get(object.get(podspec, "securityContext", {}), "seccompProfile", {}), "type", "") != "RuntimeDefault"
}
