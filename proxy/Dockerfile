# syntax=docker/dockerfile:1
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/proxy .

# distroless nonroot: běží i s náhodným UID na OpenShiftu
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/proxy /proxy
EXPOSE 8080
ENTRYPOINT ["/proxy"]
