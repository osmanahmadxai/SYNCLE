{{- define "syncle.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "syncle.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "syncle.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "syncle.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "syncle.selector" -}}
app.kubernetes.io/name: {{ include "syncle.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "syncle.image" -}}
{{- printf "%s:%s" .Values.image.repository (default (printf "v%s" .Chart.AppVersion) .Values.image.tag) -}}
{{- end -}}

{{/* the Secret the API reads DATABASE_URL, REDIS_URL and the master key from */}}
{{- define "syncle.envSecret" -}}
{{- printf "%s-env" (include "syncle.fullname" .) -}}
{{- end -}}

{{- define "syncle.postgresHost" -}}
{{- printf "%s-postgres" (include "syncle.fullname" .) -}}
{{- end -}}

{{- define "syncle.redisHost" -}}
{{- printf "%s-redis" (include "syncle.fullname" .) -}}
{{- end -}}

{{/* the master key: refused when nothing is set — a generated one would live in the pod */}}
{{- define "syncle.masterKeyRef" -}}
{{- if .Values.masterKey.existingSecret -}}
name: {{ .Values.masterKey.existingSecret }}
key: {{ .Values.masterKey.key }}
{{- else if .Values.masterKey.value -}}
name: {{ include "syncle.envSecret" . }}
key: SYNCLE_MASTER_KEY
{{- else -}}
{{- fail "Set masterKey.value (openssl rand -base64 32) or masterKey.existingSecret: the master key encrypts every stored credential, and one generated inside a pod would be lost with it." -}}
{{- end -}}
{{- end -}}

{{/* what this release's origin is, for the API's same-origin check on writes */}}
{{- define "syncle.webOrigin" -}}
{{- if .Values.webOrigin -}}
{{- .Values.webOrigin -}}
{{- else if .Values.ingress.enabled -}}
{{- printf "%s://%s" (ternary "https" "http" (gt (len .Values.ingress.tls) 0)) .Values.ingress.host -}}
{{- end -}}
{{- end -}}
