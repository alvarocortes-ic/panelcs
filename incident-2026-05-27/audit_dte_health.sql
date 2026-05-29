/* Auditoría DTE Health — replicar exactamente la query del workflow + validaciones complementarias.
   Contexto: usuario reporta dudas sobre los números del Tab DTE Health del Panel CS.
   Webhook devolvió hoy: count=2546, count_ok=987, count_error=1559.
   Esta auditoría: replica + chequea (1) duplicados por múltiples certs, (2) zona horaria, (3) volumen real ConsultaDTESII.
*/

SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

PRINT '=== 1. Replica EXACTA de la query del workflow (totales) ===';

;WITH ConsultasUltDia AS (
    SELECT DISTINCT ReceptorId
    FROM Agilice.hub.ConsultaDTESII WITH (NOLOCK)
    WHERE FechaCreacion > DATEADD(DAY, -1, GETDATE())
)
SELECT
    COUNT(*)                                                                AS total_filas,
    SUM(CASE WHEN c2.ReceptorId IS NULL THEN 1 ELSE 0 END)                  AS error_n,
    SUM(CASE WHEN c2.ReceptorId IS NOT NULL THEN 1 ELSE 0 END)              AS ok_n
FROM Agilice.hub.Empresas e WITH (NOLOCK)
INNER JOIN Agilice.dte.Certificado c WITH (NOLOCK)
    ON c.EmpresaId = e.Id
   AND c.Activo = 1
   AND c.FechaExpiracion > GETDATE()
LEFT JOIN ConsultasUltDia c2 ON c2.ReceptorId = e.Id;

PRINT '';
PRINT '=== 2. Empresas con MULTIPLES certs activos vigentes (potenciales duplicados en el resultado) ===';

SELECT TOP 20
    e.Id, e.Rut, e.RazonSocial,
    COUNT(*) AS certs_activos_vigentes
FROM Agilice.hub.Empresas e WITH (NOLOCK)
INNER JOIN Agilice.dte.Certificado c WITH (NOLOCK)
    ON c.EmpresaId = e.Id
   AND c.Activo = 1
   AND c.FechaExpiracion > GETDATE()
GROUP BY e.Id, e.Rut, e.RazonSocial
HAVING COUNT(*) > 1
ORDER BY certs_activos_vigentes DESC, e.RazonSocial;

PRINT '';
PRINT '=== 2b. Total empresas únicas vs filas (gap = duplicados) ===';
SELECT
    COUNT(DISTINCT e.Id) AS empresas_unicas,
    COUNT(*)             AS filas_totales,
    COUNT(*) - COUNT(DISTINCT e.Id) AS duplicados_por_multi_cert
FROM Agilice.hub.Empresas e WITH (NOLOCK)
INNER JOIN Agilice.dte.Certificado c WITH (NOLOCK)
    ON c.EmpresaId = e.Id
   AND c.Activo = 1
   AND c.FechaExpiracion > GETDATE();

PRINT '';
PRINT '=== 3. Zona horaria del SQL Server (¿GETDATE() devuelve hora local Chile o UTC?) ===';
SELECT
    GETDATE()       AS getdate_local,
    GETUTCDATE()    AS getdate_utc,
    DATEDIFF(MINUTE, GETUTCDATE(), GETDATE()) / 60.0 AS offset_horas;

PRINT '';
PRINT '=== 4. Volumen real de Hub.ConsultaDTESII en las últimas 24h ===';
SELECT
    COUNT(*)                       AS filas_ultimas_24h,
    COUNT(DISTINCT ReceptorId)     AS receptores_distintos_ultimas_24h,
    MIN(FechaCreacion)             AS fecha_min,
    MAX(FechaCreacion)             AS fecha_max
FROM Agilice.hub.ConsultaDTESII WITH (NOLOCK)
WHERE FechaCreacion > DATEADD(DAY, -1, GETDATE());

PRINT '';
PRINT '=== 5. ¿Hay empresas que SI consultaron pero quedan FUERA del resultado (sin cert activo)? ===';
SELECT TOP 20
    cd.ReceptorId,
    e.Rut,
    e.RazonSocial,
    -- ¿tiene cert pero está expirado o desactivado?
    (SELECT COUNT(*) FROM Agilice.dte.Certificado c WITH (NOLOCK)
        WHERE c.EmpresaId = cd.ReceptorId)                                          AS certs_totales,
    (SELECT COUNT(*) FROM Agilice.dte.Certificado c WITH (NOLOCK)
        WHERE c.EmpresaId = cd.ReceptorId AND c.Activo = 1)                         AS certs_activos,
    (SELECT COUNT(*) FROM Agilice.dte.Certificado c WITH (NOLOCK)
        WHERE c.EmpresaId = cd.ReceptorId AND c.FechaExpiracion > GETDATE())        AS certs_vigentes,
    (SELECT MAX(c.FechaExpiracion) FROM Agilice.dte.Certificado c WITH (NOLOCK)
        WHERE c.EmpresaId = cd.ReceptorId)                                          AS cert_expira_mas_tarde
FROM (
    SELECT DISTINCT ReceptorId FROM Agilice.hub.ConsultaDTESII WITH (NOLOCK)
    WHERE FechaCreacion > DATEADD(DAY, -1, GETDATE())
) cd
LEFT JOIN Agilice.hub.Empresas e WITH (NOLOCK) ON e.Id = cd.ReceptorId
WHERE NOT EXISTS (
    SELECT 1 FROM Agilice.dte.Certificado c WITH (NOLOCK)
    WHERE c.EmpresaId = cd.ReceptorId AND c.Activo = 1 AND c.FechaExpiracion > GETDATE()
)
ORDER BY cd.ReceptorId;

PRINT '';
PRINT '=== 6. Distribucion temporal — ¿la cron de consultas SII está saludable? ===';
SELECT
    DATEPART(HOUR, FechaCreacion) AS hora,
    COUNT(*)                       AS n_consultas,
    COUNT(DISTINCT ReceptorId)     AS receptores_distintos
FROM Agilice.hub.ConsultaDTESII WITH (NOLOCK)
WHERE FechaCreacion > DATEADD(DAY, -1, GETDATE())
GROUP BY DATEPART(HOUR, FechaCreacion)
ORDER BY hora;
