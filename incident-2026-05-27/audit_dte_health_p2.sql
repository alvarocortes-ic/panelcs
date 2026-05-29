/* DTE Health — segunda pasada: caracterizar las 1559 empresas en "Error".
   ¿Son empresas activas que se atrasaron? ¿O empresas zombie que jamás consultan?
*/

SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

PRINT '=== 1. Buckets de tiempo desde la última consulta SII — para las empresas con cert activo+vigente ===';

;WITH UltimaConsultaPorEmp AS (
    SELECT
        e.Id  AS empresa_id,
        e.Rut,
        e.RazonSocial,
        (SELECT MAX(c.FechaCreacion) FROM Agilice.hub.ConsultaDTESII c WITH (NOLOCK)
            WHERE c.ReceptorId = e.Id) AS ultima_consulta
    FROM Agilice.hub.Empresas e WITH (NOLOCK)
    INNER JOIN Agilice.dte.Certificado c WITH (NOLOCK)
        ON c.EmpresaId = e.Id
       AND c.Activo = 1
       AND c.FechaExpiracion > GETDATE()
), Bucketed AS (
    SELECT
        empresa_id, Rut, RazonSocial, ultima_consulta,
        CASE
            WHEN ultima_consulta IS NULL                                           THEN '00-Nunca'
            WHEN ultima_consulta >  DATEADD(DAY,    -1, GETDATE())                 THEN '01-Ultimas 24h'
            WHEN ultima_consulta >  DATEADD(DAY,    -2, GETDATE())                 THEN '02-24-48h'
            WHEN ultima_consulta >  DATEADD(DAY,    -7, GETDATE())                 THEN '03-2-7d'
            WHEN ultima_consulta >  DATEADD(DAY,   -30, GETDATE())                 THEN '04-7-30d'
            WHEN ultima_consulta >  DATEADD(DAY,   -90, GETDATE())                 THEN '05-30-90d'
            WHEN ultima_consulta >  DATEADD(DAY,  -365, GETDATE())                 THEN '06-90d-1a'
            ELSE                                                                        '07-Mas de 1 anio'
        END AS bucket
    FROM UltimaConsultaPorEmp
)
SELECT bucket, COUNT(*) AS empresas, MIN(ultima_consulta) AS min_dt, MAX(ultima_consulta) AS max_dt
FROM Bucketed
GROUP BY bucket
ORDER BY bucket;


PRINT '';
PRINT '=== 2. Top 30 empresas que NUNCA consultaron (cert vivo pero ConsultaDTESII vacio para el RUT) ===';

SELECT TOP 30
    e.Id, e.Rut, e.RazonSocial,
    c_act.fec_creacion_cert AS cert_creado,
    c_act.fec_expira_cert    AS cert_expira
FROM Agilice.hub.Empresas e WITH (NOLOCK)
INNER JOIN (
    SELECT EmpresaId,
           MAX(FechaCreacion)    AS fec_creacion_cert,
           MAX(FechaExpiracion)  AS fec_expira_cert
    FROM Agilice.dte.Certificado WITH (NOLOCK)
    WHERE Activo = 1 AND FechaExpiracion > GETDATE()
    GROUP BY EmpresaId
) c_act ON c_act.EmpresaId = e.Id
WHERE NOT EXISTS (
    SELECT 1 FROM Agilice.hub.ConsultaDTESII cd WITH (NOLOCK)
    WHERE cd.ReceptorId = e.Id
)
ORDER BY c_act.fec_creacion_cert DESC;


PRINT '';
PRINT '=== 3. Distribución diaria — últimos 7 días — cuántos receptores distintos por día ===';

SELECT
    CAST(FechaCreacion AS DATE) AS dia,
    COUNT(*)                    AS filas,
    COUNT(DISTINCT ReceptorId)  AS receptores
FROM Agilice.hub.ConsultaDTESII WITH (NOLOCK)
WHERE FechaCreacion > DATEADD(DAY, -7, GETDATE())
GROUP BY CAST(FechaCreacion AS DATE)
ORDER BY dia DESC;


PRINT '';
PRINT '=== 4. ¿Las consultas son nominales o reales? — verificar TotalDocumentos ===';

SELECT
    CASE WHEN TotalDocumentos = 0 THEN 'TotalDocs=0 (consulta vacía)'
         WHEN TotalDocumentos < 5 THEN '1-4 docs'
         WHEN TotalDocumentos < 50 THEN '5-49 docs'
         WHEN TotalDocumentos < 500 THEN '50-499 docs'
         ELSE '500+ docs'
    END AS rango,
    COUNT(*)                       AS n_consultas,
    COUNT(DISTINCT ReceptorId)     AS receptores_distintos
FROM Agilice.hub.ConsultaDTESII WITH (NOLOCK)
WHERE FechaCreacion > DATEADD(DAY, -1, GETDATE())
GROUP BY
    CASE WHEN TotalDocumentos = 0 THEN 'TotalDocs=0 (consulta vacía)'
         WHEN TotalDocumentos < 5 THEN '1-4 docs'
         WHEN TotalDocumentos < 50 THEN '5-49 docs'
         WHEN TotalDocumentos < 500 THEN '50-499 docs'
         ELSE '500+ docs'
    END
ORDER BY rango;
