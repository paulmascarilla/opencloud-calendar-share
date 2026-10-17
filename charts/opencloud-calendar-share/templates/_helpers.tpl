{{- define "calendar.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "calendar.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else if contains (include "calendar.name" .) .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "calendar.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "calendar.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "calendar.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "calendar.selectorLabels" -}}
app.kubernetes.io/name: {{ include "calendar.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "calendar.opencloudNamespace" -}}
{{- default .Release.Namespace .Values.opencloud.namespace }}
{{- end }}

{{/* Radicale service as seen from OpenCloud (may live in another namespace) */}}
{{- define "calendar.serviceHost" -}}
{{- printf "%s.%s.svc" (include "calendar.fullname" .) .Release.Namespace }}
{{- end }}

{{- define "calendar.calshareImage" -}}
{{- printf "%s:%s" .Values.calshare.image.repository (default .Chart.AppVersion .Values.calshare.image.tag) }}
{{- end }}

{{- define "calendar.webImage" -}}
{{- printf "%s:%s" .Values.webExtension.image.repository (default .Chart.AppVersion .Values.webExtension.image.tag) }}
{{- end }}

{{/* Secret shared by the OpenCloud proxy and calshare (proxy-secret.yaml): kept across upgrades,
     generated once per render otherwise (several templates need the same value). */}}
{{- define "calendar.proxySecret" -}}
{{- if not (hasKey .Values "__proxySecret") }}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (printf "%s-proxy-secret" (include "calendar.fullname" .)) }}
{{- $value := "" }}
{{- if and $existing $existing.data (hasKey $existing.data "secret") }}
{{- $value = index $existing.data "secret" | b64dec }}
{{- else }}
{{- $value = randAlphaNum 48 }}
{{- end }}
{{- $_ := set .Values "__proxySecret" $value }}
{{- end }}
{{- .Values.__proxySecret }}
{{- end }}
